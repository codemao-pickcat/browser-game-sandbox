import { SandboxBridgeError } from "./errors.js";
import {
  LOCAL_STORAGE_BATCH_BYTES,
  LOCAL_STORAGE_BATCH_ENTRIES,
  localStorageBytes,
  SANDBOX_STORAGE_LIMITS as limits,
  type LocalStorageEntry,
} from "./package-storage-limits.js";

type GameMethods = Readonly<Record<string, (payload: unknown) => Promise<unknown>>>;

/** Load the scoped save before work scripts can synchronously read Web Storage. */
export async function installMemoryStorage(api: GameMethods, cleanup: (() => void)[]): Promise<void> {
  let remaining = limits.sessionWriteBytes;
  let bufferedWrites = 0;
  const encoder = new TextEncoder();
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try { void window[name]; continue; }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
    }
    const load = name === "localStorage" ? api.storageLocalLoad : undefined;
    const apply = name === "localStorage" ? api.storageLocalApply : undefined;
    const entries = new Map<string, string>();
    let sync: ReturnType<typeof createSync> | undefined;
    if (load && apply) {
      try {
        for (const [key, value] of await load({}) as LocalStorageEntry[]) entries.set(key, value);
        sync = createSync(apply, cleanup);
      } catch {
        // Keep startup usable but do not write over data we failed to load.
        entries.clear();
        console.warn("Offline localStorage preload failed; changes will stay in memory");
      }
    }
    let storedBytes = 0;
    for (const [key, value] of entries) storedBytes += localStorageBytes(key, value);
    const quotaExceeded = () => new DOMException("Offline Web Storage write quota exceeded", "QuotaExceededError");
    const storage = {
      get length() { return entries.size; },
      key(index: number) {
        let position = index >>> 0;
        for (const key of entries.keys()) if (position-- === 0) return key;
        return null;
      },
      getItem(key: string) { return entries.get(String(key)) ?? null; },
      setItem(key: string, value: string) {
        key = String(key);
        value = String(value);
        const previous = entries.get(key);
        if (key.length + value.length > remaining) throw quotaExceeded();
        const bytes = encoder.encode(key).byteLength + encoder.encode(value).byteLength;
        if (bytes > remaining) throw quotaExceeded();
        if (sync && value !== previous) {
          const nextBytes = storedBytes + bytes + 3 - (previous === undefined ? 0 : localStorageBytes(key, previous));
          if (nextBytes > limits.localStorageBytes || (previous === undefined && entries.size >= limits.localStorageEntries)) throw quotaExceeded();
          const charge = bytes + 3;
          if (bufferedWrites + charge > limits.sessionWriteBytes) throw quotaExceeded();
          sync.change(key, value);
          storedBytes = nextBytes;
          bufferedWrites += charge;
        }
        entries.set(key, value);
        remaining -= bytes;
      },
      removeItem(key: string) {
        key = String(key);
        const previous = entries.get(key);
        if (previous === undefined) return;
        if (sync) {
          const charge = localStorageBytes(key, null);
          if (bufferedWrites + charge > limits.sessionWriteBytes) throw quotaExceeded();
          sync.change(key, null);
          bufferedWrites += charge;
          storedBytes -= localStorageBytes(key, previous);
        }
        entries.delete(key);
      },
      clear() {
        sync?.clear();
        storedBytes = 0;
        entries.clear();
      },
    } satisfies Storage;
    Object.defineProperty(window, name, { value: Object.freeze(storage), enumerable: true, configurable: false, writable: false });
    cleanup.push(entries.clear.bind(entries));
  }
}

function createSync(apply: (payload: unknown) => Promise<unknown>, cleanup: (() => void)[]) {
  let pending = new Map<string, string | null>();
  let pendingBytes = 0;
  let clear = false;
  let stopped = false;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retry: (() => void) | undefined;
  const schedule = () => {
    if (!stopped && !sending && timer === undefined && (clear || pending.size)) {
      timer = setTimeout(() => void flush(), 100);
    }
  };
  const flush = async () => {
    timer = undefined;
    if (stopped || (!clear && !pending.size)) return;
    sending = true;
    const changes = pending;
    const clearFirst = clear;
    pending = new Map();
    pendingBytes = 0;
    clear = false;
    const payload = { clear: clearFirst, changes: [...changes] };
    try {
      try { await apply(payload); }
      catch (error) {
        if (stopped || !(error instanceof SandboxBridgeError) || error.code !== "RATE_LIMITED") throw error;
        await new Promise<void>(resolve => {
          retry = () => { clearTimeout(retryTimer); retry = undefined; resolve(); };
          retryTimer = setTimeout(retry, 1000);
        });
        if (!stopped) await apply(payload);
      }
    } catch {
      if (!stopped) console.warn("Offline localStorage could not save changes");
    } finally {
      sending = false;
      schedule();
    }
  };
  cleanup.push(() => {
    stopped = true;
    clearTimeout(timer);
    retry?.();
    pending = new Map();
  });
  return {
    change(key: string, value: string | null) {
      const previous = pending.get(key);
      const nextBytes = pendingBytes + localStorageBytes(key, value) - (previous === undefined ? 0 : localStorageBytes(key, previous));
      if (nextBytes > LOCAL_STORAGE_BATCH_BYTES || (previous === undefined && pending.size >= LOCAL_STORAGE_BATCH_ENTRIES)) {
        throw new DOMException("Offline localStorage has too many pending changes", "QuotaExceededError");
      }
      pending.set(key, value);
      pendingBytes = nextBytes;
      schedule();
    },
    clear() {
      clear = true;
      pending.clear();
      pendingBytes = 0;
      schedule();
    },
  };
}
