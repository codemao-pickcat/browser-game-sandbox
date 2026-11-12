import { PACKAGE_BOOTSTRAP_SOURCE } from "./package-bootstrap-source.js";
import { buildOfflineBrowserPolicy } from "./browser-capabilities.js";
import { SandboxHostRpcSession } from "./host.js";
import { assertValidOrigin } from "./protocol.js";
import { snapshotPreparedPackage, type PreparedSandboxPackage } from "./package-prepare.js";
import { SANDBOX_PACKAGE_LIMITS as LIMITS, type PackageSnapshot } from "./package-format.js";
import { packageStoragePlugin, type SandboxStorageAdapter } from "./package-storage.js";

export interface SandboxPackageSessionOptions {
  readonly container: HTMLElement;
  readonly package: PreparedSandboxPackage;
  readonly storage?: SandboxStorageAdapter;
  readonly onTerminate?: (reason: string) => void;
}
export interface SandboxPackageSession {
  readonly iframe: HTMLIFrameElement;
  readonly connected: Promise<void>;
  readonly ready: Promise<void>;
  terminate(reason?: string): void;
}

/** Native-browser, best-effort offline execution in a unique opaque iframe. */
export function createSandboxPackageSession(options: SandboxPackageSessionOptions): SandboxPackageSession {
  const { container, onTerminate } = options;
  const doc = container.ownerDocument;
  const hostWindow = doc.defaultView;
  if (!hostWindow) throw new TypeError("Package session requires a live browser document");
  assertValidOrigin(hostWindow.location.origin);
  let snapshot: PackageSnapshot | undefined = snapshotPreparedPackage(options.package);
  const storage = packageStoragePlugin(options.storage);
  const policy = buildOfflineBrowserPolicy();
  const token = Array.from(hostWindow.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const iframe = doc.createElement("iframe");
  iframe.setAttribute("sandbox", policy.sandboxTokens.join(" "));
  iframe.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; clipboard-read 'none'; clipboard-write 'none'");
  iframe.referrerPolicy = "no-referrer";
  iframe.title = "Sandbox package";
  let stopped = false, loadObserved = false, portTransferred = false, bootstrapConnected = false, readySettled = false;
  let control: MessagePort | undefined;
  let pendingAck: { sequence: number; resolve(): void; reject(error: Error): void } | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Consumers may await connected first; termination must not create an
  // unhandled rejection on the other independently exposed lifecycle promise.
  void ready.catch(() => {});
  const cleanup = (reason: string) => {
    if (stopped) return;
    stopped = true; snapshot = undefined;
    clearTimeout(timer);
    hostWindow.removeEventListener("message", onWindowMessage);
    iframe.removeEventListener("load", onLoad);
    control?.close(); control = undefined;
    pendingAck?.reject(new Error(reason)); pendingAck = undefined;
    try { iframe.remove(); } catch { /* Port/listener cleanup still completes. */ }
    if (!readySettled) { readySettled = true; rejectReady(new Error(reason)); }
    onTerminate?.(reason);
  };
  const rpc = new SandboxHostRpcSession({ ...storage, onTerminate: cleanup });
  void rpc.connected.catch(() => {});
  const terminate = (reason = "Sandbox package terminated") => rpc.terminate(reason);
  const timer = setTimeout(() => terminate("Sandbox package load timed out"), LIMITS.transferTimeoutMs);
  const onLoad = () => {
    if (!loadObserved) { loadObserved = true; return; }
    terminate("Sandbox iframe navigated after its bootstrap document");
  };
  function waitAck(sequence: number, send: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (stopped || !control) { reject(new Error("Package transfer terminated")); return; }
      pendingAck = { sequence, resolve, reject };
      try { send(); } catch (error) { pendingAck = undefined; reject(error); }
    });
  }
  async function transfer(): Promise<void> {
    const payload = snapshot;
    if (!payload || stopped || !control) return;
    await waitAck(-1, () => control!.postMessage({ type: "begin", manifest: payload.manifest, totalBytes: payload.totalBytes }));
    let sequence = 0;
    for (const [path, bytes] of Object.entries(payload.files)) {
      for (let offset = 0; offset < bytes.byteLength || (offset === 0 && bytes.byteLength === 0); offset += LIMITS.transferChunkBytes) {
        if (stopped) throw new Error("Package transfer terminated");
        const chunk = bytes.slice(offset, offset + LIMITS.transferChunkBytes);
        await waitAck(sequence, () => control!.postMessage({ type: "chunk", sequence, path, offset, bytes: chunk }, [chunk.buffer]));
        sequence++;
      }
    }
    snapshot = undefined;
    if (!stopped) control!.postMessage({ type: "finish" });
  }
  const onControlMessage = (event: MessageEvent) => {
    if (stopped) return;
    const data = event.data;
    if (data?.type === "connected" && !bootstrapConnected && control) {
      bootstrapConnected = true;
      const channel = new MessageChannel();
      rpc.attachAuthenticatedPort(channel.port1);
      control.postMessage({ type: "rpc", init: rpc.initMessage, methods: storage.gameApi }, [channel.port2]);
      void rpc.connected.then(transfer).catch(() => terminate("Package transfer or RPC handshake failed"));
    } else if (data?.type === "ack" && pendingAck && data.sequence === pendingAck.sequence) {
      const ack = pendingAck; pendingAck = undefined; ack.resolve();
    } else if (data?.type === "ready" && bootstrapConnected && !pendingAck && !snapshot && !readySettled && rpc.state === "connected") {
      readySettled = true; clearTimeout(timer); resolveReady(); control?.close(); control = undefined;
    } else if (data?.type === "error" && typeof data.message === "string") terminate(data.message.slice(0, 256));
    else terminate("Invalid package control message");
  };
  const onWindowMessage = (event: MessageEvent) => {
    if (stopped || portTransferred || !loadObserved || event.origin !== "null" || event.source !== iframe.contentWindow ||
        event.data?.type !== "sandbox:package-bootstrap" || event.data?.version !== 1 || event.data?.token !== token || event.ports.length !== 0) return;
    portTransferred = true;
    hostWindow.removeEventListener("message", onWindowMessage);
    const channel = new MessageChannel(); control = channel.port1;
    control.onmessage = onControlMessage;
    control.onmessageerror = () => terminate("Package MessagePort decoding failed"); control.start();
    try { iframe.contentWindow!.postMessage({ type: "sandbox:package-init", version: 1, token }, "*", [channel.port2]); }
    catch { channel.port2.close(); terminate("Unable to transfer package port"); }
  };
  const config = JSON.stringify({ token, hostOrigin: hostWindow.location.origin }).replaceAll("<", "\\u003c");
  const script = `(() => {${PACKAGE_BOOTSTRAP_SOURCE}\nSandboxPackageBootstrap.startPackageBootstrap(${config});})();`.replace(/<\/script/gi, "<\\/script");
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy.contentSecurityPolicy}"><meta name="referrer" content="no-referrer"><script>${script}</script></head><body></body></html>`;
  hostWindow.addEventListener("message", onWindowMessage);
  iframe.addEventListener("load", onLoad);
  rpc.start();
  try { container.append(iframe); } catch (error) { terminate("Unable to mount sandbox iframe"); throw error; }
  return Object.freeze({ iframe, connected: rpc.connected, ready, terminate });
}
