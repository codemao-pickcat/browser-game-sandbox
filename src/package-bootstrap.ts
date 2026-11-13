import { SandboxBridgeClient } from "./client.js";
import { isBridgeInitMessage, assertValidOrigin } from "./protocol.js";
import { parseSandboxGamePreloadConfig, type SandboxGameApiBindings } from "./game-api-config.js";
import { loadSandboxPackage } from "./package-loader.js";
import { prepareSandboxPackage, snapshotPreparedPackage } from "./package-prepare.js";
import { SANDBOX_PACKAGE_LIMITS as LIMITS, validatePackageManifest, type SandboxPackageManifest } from "./package-format.js";

// Only the trusted SDK writes this script/config into srcdoc. It is not a
// resource from the uploaded package and never executes before authentication.
export function startPackageBootstrap(config: { token: string; hostOrigin: string }): void {
  assertValidOrigin(config.hostOrigin);
  const expectedParent = window.parent;
  let used = false;
  const onInit = (event: MessageEvent) => {
    if (used || event.source !== expectedParent || event.origin !== config.hostOrigin ||
        event.data?.type !== "sandbox:package-init" || event.data?.version !== 1 || event.data?.token !== config.token || event.ports.length !== 1) return;
    used = true;
    window.removeEventListener("message", onInit);
    const control = event.ports[0]!;
    const post = control.postMessage.bind(control);
    let client: SandboxBridgeClient | undefined;
    let methods: SandboxGameApiBindings = {};
    let manifest: SandboxPackageManifest | undefined;
    let paths: readonly string[] = [];
    let index = 0, offset = 0, received = 0, nextSequence = 0;
    let expectedBytes = 0;
    let finished = false;
    let files: Record<string, Uint8Array> = Object.create(null);
    let timer = setTimeout(() => fail("Package transfer timed out"), LIMITS.transferTimeoutMs);
    const fail = (message: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); files = Object.create(null);
      try { post({ type: "error", message: message.slice(0, 256) }); } finally { control.close(); client?.close(); }
    };
    control.onmessageerror = () => fail("Package port decoding failed");
    control.onmessage = event => {
      if (finished) return;
      try {
        const data = event.data;
        if (data?.type === "rpc" && !client && !manifest && event.ports.length === 1 && isBridgeInitMessage(data.init)) {
          methods = parseSandboxGamePreloadConfig({ expectedHostOrigin: config.hostOrigin, methods: data.methods }).methods;
          client = new SandboxBridgeClient(event.ports[0]!, { maxPayloadBytes: data.init.maxPayloadBytes });
          client.sendReady();
          return;
        }
        if (data?.type === "begin" && client && !manifest) {
          const checked = validatePackageManifest(data.manifest);
          if (checked.totalBytes !== data.totalBytes) throw new TypeError("Invalid package byte budget");
          manifest = checked.manifest;
          paths = checked.paths;
          expectedBytes = checked.totalBytes;
          for (const path of paths) files[path] = new Uint8Array(manifest.files[path]!.size);
          post({ type: "ack", sequence: -1 });
          return;
        }
        if (data?.type === "chunk" && manifest && client) {
          const path = paths[index];
          if (!path || data.path !== path || data.offset !== offset || !(data.bytes instanceof Uint8Array) ||
              data.bytes.byteLength > LIMITS.transferChunkBytes || data.sequence !== nextSequence) throw new TypeError("Invalid package chunk");
          const target = files[path]!;
          if (offset + data.bytes.byteLength > target.byteLength || (!data.bytes.byteLength && target.byteLength)) throw new TypeError("Chunk exceeds file budget");
          target.set(data.bytes, offset); offset += data.bytes.byteLength; received += data.bytes.byteLength;
          if (offset === target.byteLength) { index++; offset = 0; }
          nextSequence++;
          post({ type: "ack", sequence: data.sequence });
          return;
        }
        if (data?.type === "finish" && manifest && client && index === paths.length && received === expectedBytes) {
          finished = true;
          const input = { manifest, files };
          // Ignore further messages permanently; no rebinding or duplicate finish.
          control.onmessage = null;
          void (async () => {
            try {
              const prepared = await prepareSandboxPackage(input, { worker: true });
              await loadSandboxPackage(snapshotPreparedPackage(prepared), client!, methods);
              files = Object.create(null);
              clearTimeout(timer);
              post({ type: "ready" }); control.close();
            } catch (error) {
              clearTimeout(timer); files = Object.create(null); client?.close();
              post({ type: "error", message: error instanceof Error ? error.message.slice(0, 256) : "Package load failed" }); control.close();
            }
          })();
          return;
        }
        throw new TypeError("Unexpected package protocol message");
      } catch (error) { fail(error instanceof Error ? error.message : "Invalid package transfer"); }
    };
    control.start();
    post({ type: "connected" });
  };
  window.addEventListener("message", onInit);
  window.addEventListener("load", () => expectedParent.postMessage({ type: "sandbox:package-bootstrap", version: 1, token: config.token }, config.hostOrigin), { once: true });
}
