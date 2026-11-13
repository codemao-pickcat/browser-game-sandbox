import { PACKAGE_PREPARE_WORKER_SOURCE } from "./package-prepare-worker-source.js";
import { prepareSandboxPackage as prepareOnThread, verifyPackageBytes, adoptPreparedSnapshot, type PreparedSandboxPackage } from "./package-compiler.js";
import { SandboxPackageError, type SandboxPackageInput, type PackageSnapshot } from "./package-format.js";
export { compilePackage, snapshotPreparedPackage, type PreparedSandboxPackage } from "./package-compiler.js";
export { SANDBOX_PACKAGE_LIMITS, SANDBOX_RUNTIME_VERSION, SandboxPackageError, type SandboxPackageInput, type SandboxPackageManifest } from "./package-format.js";

export interface PrepareSandboxPackageOptions {
  /** Parse in an SDK-owned worker. Requires worker-src blob: in the trusted host. */
  readonly worker?: boolean;
  readonly signal?: AbortSignal;
}

/** Validates bytes without executing user code. Worker mode keeps parsing off the UI thread. */
export async function prepareSandboxPackage(input: SandboxPackageInput, options: PrepareSandboxPackageOptions = {}): Promise<PreparedSandboxPackage> {
  options.signal?.throwIfAborted();
  if (!options.worker) return prepareOnThread(input);
  // Opaque Blob workers do not expose SubtleCrypto in every browser. Keep
  // native asynchronous hashing in the calling realm; move parsing to the worker.
  const verified = await verifyPackageBytes(input);
  options.signal?.throwIfAborted();
  return new Promise<PreparedSandboxPackage>((resolve, reject) => {
    let worker: Worker | undefined;
    let url: string | undefined;
    let settled = false;
    const finish = (error?: unknown, snapshot?: PackageSnapshot) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      if (error !== undefined) reject(error);
      else {
        try { resolve(adoptPreparedSnapshot(snapshot!)); }
        catch (error) { reject(error); }
      }
    };
    const abort = () => finish(options.signal?.reason ?? new DOMException("Preparation cancelled", "AbortError"));
    try {
      url = URL.createObjectURL(new Blob([PACKAGE_PREPARE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url, { name: "sandbox-package-prepare" });
      worker.onmessage = event => {
        const data = event.data;
        if (data?.type === "prepared") finish(undefined, data.snapshot);
        else finish(new SandboxPackageError(typeof data?.code === "string" ? data.code : "PREPARE_FAILED", typeof data?.message === "string" ? data.message : "Package worker failed"));
      };
      worker.onerror = event => { event.preventDefault(); finish(new Error("Package preparation worker failed")); };
      worker.onmessageerror = () => finish(new Error("Package preparation worker decoding failed"));
      options.signal?.addEventListener("abort", abort, { once: true });
      // These are our verified snapshots, never the caller's buffers.
      worker.postMessage(verified, Object.values(verified.files).map(bytes => bytes.buffer as ArrayBuffer));
    } catch (error) { finish(error); }
  });
}
