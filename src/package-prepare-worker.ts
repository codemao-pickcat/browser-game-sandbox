import { compilePackage } from "./package-compiler.js";
import { SandboxPackageError, type PackageSnapshot } from "./package-format.js";

// Private SDK worker: receives already verified, transfer-owned bytes. No network,
// user-code execution or public API for importing arbitrary prepared handles.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Omit<PackageSnapshot, "plan">>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = event => {
  scope.onmessage = null;
  try {
    const verified = event.data;
    const snapshot: PackageSnapshot = { ...verified, plan: compilePackage(verified.files) };
    scope.postMessage({ type: "prepared", snapshot }, Object.values(snapshot.files).map(bytes => bytes.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ type: "error", code: error instanceof SandboxPackageError ? error.code : "PREPARE_FAILED", message: error instanceof Error ? error.message : "Package preparation failed" });
  }
};
