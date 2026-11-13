import {
  prepareSandboxPackage, createSandboxPackageSession, SANDBOX_RUNTIME_VERSION,
  type SandboxPackageManifest, type SandboxPackageInput, type SandboxStorageAdapter,
  type PreparedSandboxPackage, type SandboxPackageSession,
} from "../../src/index.js";

const manifest: SandboxPackageManifest = { formatVersion: 1, entrypoint: "index.html", files: { "index.html": { sha256: "0".repeat(64), size: 1 } } };
const input: SandboxPackageInput = { manifest, files: { "index.html": new Uint8Array([1]) } };
const prepared: Promise<PreparedSandboxPackage> = prepareSandboxPackage(input);
const version: "0.3.2" = SANDBOX_RUNTIME_VERSION;
const storage: SandboxStorageAdapter = { async get(_key) { return null; }, async set(_key, _value) {}, async delete(_key) {} };
async function session(container: HTMLElement): Promise<SandboxPackageSession> {
  const result = createSandboxPackageSession({ container, package: await prepared, storage, onTerminate: (_reason: string) => {} });
  const connected: Promise<void> = result.connected;
  const ready: Promise<void> = result.ready;
  result.terminate("reason");
  void connected; void ready;
  return result;
}
// @ts-expect-error Entrypoint is a fixed contract, not caller-selectable.
const badManifest: SandboxPackageManifest = { formatVersion: 1, entrypoint: "other.html", files: {} };
// @ts-expect-error Storage only returns strings or null, not arbitrary JSON.
const badStorage: SandboxStorageAdapter = { async get(_key: string) { return {}; }, async set() {}, async delete() {} };
void session; void version; void badManifest; void badStorage;
