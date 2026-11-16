import type { SandboxPackageManifest } from "./package-format.js";

export type SandboxPackageFileLoader = (path: string, signal: AbortSignal) => Promise<Uint8Array>;

export function serveDeferredFiles(
  port: MessagePort, manifest: SandboxPackageManifest, paths: readonly string[], load: SandboxPackageFileLoader,
): () => void {
  const allowed = new Set(paths);
  const queued = new Set<string>();
  const active = new Set<string>();
  const controller = new AbortController();
  const close = () => { controller.abort(); queued.clear(); port.close(); };
  async function send(path: string) {
    try {
      const metadata = manifest.files[path]!;
      const source = await load(path, controller.signal);
      controller.signal.throwIfAborted();
      if (!(source instanceof Uint8Array) || source.byteLength !== metadata.size) throw new TypeError("Invalid package file size");
      const bytes = new Uint8Array(source);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== metadata.sha256) throw new TypeError("Invalid package file digest");
      if (!controller.signal.aborted) port.postMessage({ path, blob: new Blob([bytes]) });
    } catch {
      if (!controller.signal.aborted) port.postMessage({ path });
    } finally {
      active.delete(path);
      pump();
    }
  }
  function pump() {
    for (const path of queued) {
      if (active.size >= 4 || controller.signal.aborted) break;
      queued.delete(path);
      active.add(path);
      void send(path);
    }
  }
  port.onmessage = ({ data, ports }) => {
    if (ports.length || typeof data !== "string" || !allowed.has(data) || active.has(data)) return;
    queued.add(data);
    pump();
  };
  port.onmessageerror = close;
  return close;
}

export function openDeferredFiles(port: MessagePort, manifest: SandboxPackageManifest) {
  const pending = new Map<string, {
    promise: Promise<Blob>; resolve(blob: Blob): void; reject(error: unknown): void;
  }>();
  const cached = new Map<string, Blob>();
  const failure = () => new TypeError("Package resource could not be loaded");
  let closed = false;
  const close = () => {
    closed = true;
    port.close();
    for (const request of pending.values()) request.reject(failure());
    pending.clear();
    cached.clear();
  };
  port.onmessage = ({ data }) => {
    const request = pending.get(data?.path);
    if (!request) return;
    pending.delete(data.path);
    if (!(data.blob instanceof Blob) || data.blob.size !== manifest.files[data.path]?.size) {
      request.reject(failure());
      return;
    }
    cached.set(data.path, data.blob);
    request.resolve(data.blob);
  };
  port.onmessageerror = close;
  return {
    close,
    async read(path: string, signal?: AbortSignal): Promise<Blob> {
      signal?.throwIfAborted();
      if (closed) throw failure();
      const known = cached.get(path);
      if (known) return known;
      let request = pending.get(path);
      if (!request) {
        let resolve!: (blob: Blob) => void, reject!: (error: unknown) => void;
        const promise = new Promise<Blob>((accept, refuse) => { resolve = accept; reject = refuse; });
        request = { promise, resolve, reject };
        pending.set(path, request);
        try { port.postMessage(path); }
        catch (error) { pending.delete(path); reject(error); }
      }
      const { promise } = request;
      if (!signal) return promise;
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void promise.then(
          blob => { signal.removeEventListener("abort", abort); resolve(blob); },
          error => { signal.removeEventListener("abort", abort); reject(error); },
        );
      });
    },
  };
}
