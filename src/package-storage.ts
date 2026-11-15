import { z } from "zod";
import { defineMethod, defineSandboxPlugin } from "./plugin.js";
import { composeHostPlugins, createHostPlugin, type ComposedHostPlugins } from "./host-plugin.js";
import {
  LOCAL_STORAGE_BATCH_BYTES,
  LOCAL_STORAGE_BATCH_ENTRIES,
  localStorageBytes,
  SANDBOX_STORAGE_LIMITS,
  type LocalStorageEntry,
} from "./package-storage-limits.js";

export { SANDBOX_STORAGE_LIMITS } from "./package-storage-limits.js";

export interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  readonly localStorage?: {
    load(): Promise<LocalStorageEntry[]>;
    /** Apply the callback to the latest entries and commit in one transaction. */
    update(apply: (entries: LocalStorageEntry[]) => LocalStorageEntry[], signal: AbortSignal): Promise<void>;
  };
}
const encoder = new TextEncoder();
const bounded = (bytes: number) => z.string().max(bytes).refine(value => encoder.encode(value).byteLength <= bytes);
const key = bounded(SANDBOX_STORAGE_LIMITS.keyBytes).refine(value => value.length > 0);
const value = bounded(SANDBOX_STORAGE_LIMITS.valueBytes);
const capability = "package.storage";
const localEntries = z.array(z.tuple([z.string(), z.string()]))
  .max(SANDBOX_STORAGE_LIMITS.localStorageEntries)
  .refine(entries => entries.reduce((sum, [key, value]) => sum + localStorageBytes(key, value), 0) <= SANDBOX_STORAGE_LIMITS.localStorageBytes);
const localChanges = z.array(z.tuple([z.string(), z.string().nullable()]))
  .max(LOCAL_STORAGE_BATCH_ENTRIES)
  .refine(entries => entries.reduce((sum, [key, value]) => sum + localStorageBytes(key, value), 0) <= LOCAL_STORAGE_BATCH_BYTES);
const localContract = defineSandboxPlugin({
  id: "package.local-storage", version: "1.0.0", capabilities: [capability],
  gameApi: { storageLocalLoad: "load", storageLocalApply: "apply" },
  methods: {
    load: defineMethod({ capability, input: z.object({}).strict(), output: localEntries, limits: { maxConcurrent: 1, timeoutMs: 5000 } }),
    apply: defineMethod({ capability, input: z.object({ clear: z.boolean(), changes: localChanges }).strict(), output: z.void(), limits: { maxConcurrent: 1, timeoutMs: 5000 } }),
  },
});
const contract = defineSandboxPlugin({
  id: "package.storage", version: "1.0.0", capabilities: [capability],
  gameApi: { storageGet: "get", storageSet: "set", storageDelete: "delete" },
  methods: {
    get: defineMethod({ capability, input: z.object({ key }).strict(), output: value.nullable(), limits: { maxConcurrent: 4, timeoutMs: 5000 } }),
    set: defineMethod({ capability, input: z.object({ key, value }).strict(), output: z.void(), limits: { maxConcurrent: 1, timeoutMs: 5000 } }),
    delete: defineMethod({ capability, input: z.object({ key }).strict(), output: z.void(), limits: { maxConcurrent: 1, timeoutMs: 5000 } }),
  },
});

/** Internal, each invocation captures one immutable scope and its own quotas. */
export function packageStoragePlugin(adapter?: SandboxStorageAdapter): ComposedHostPlugins {
  if (!adapter) return composeHostPlugins([]);
  const get = adapter.get.bind(adapter), set = adapter.set.bind(adapter), remove = adapter.delete.bind(adapter);
  const writeKeys = new Set<string>();
  let writtenBytes = 0;
  function charge(key: string, bytes: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if ((!writeKeys.has(key) && writeKeys.size >= SANDBOX_STORAGE_LIMITS.sessionWriteKeys) ||
        writtenBytes + bytes > SANDBOX_STORAGE_LIMITS.sessionWriteBytes) throw new Error("Session storage quota exceeded");
    writeKeys.add(key); writtenBytes += bytes;
  }
  const storage = createHostPlugin(contract, {
    get: async ({ key }, { signal }) => { signal.throwIfAborted(); return get(key); },
    set: async ({ key, value }, { signal }) => { charge(key, encoder.encode(value).byteLength, signal); await set(key, value); },
    delete: async ({ key }, { signal }) => { charge(key, 0, signal); await remove(key); },
  });
  const local = adapter.localStorage;
  if (!local) return composeHostPlugins([storage], { grantedCapabilities: [capability] });
  const loadLocal = local.load.bind(local);
  const updateLocal = local.update.bind(local);
  let localWrittenBytes = 0;
  const localStorage = createHostPlugin(localContract, {
    load: async (_input, { signal }) => {
      signal.throwIfAborted();
      return loadLocal();
    },
    apply: async ({ clear, changes }, { signal }) => {
      signal.throwIfAborted();
      const bytes = changes.reduce((sum, [key, value]) => sum + localStorageBytes(key, value), 0);
      if (localWrittenBytes + bytes > SANDBOX_STORAGE_LIMITS.sessionWriteBytes) throw new Error("Local storage write quota exceeded");
      localWrittenBytes += bytes;
      try {
        await updateLocal(entries => {
          signal.throwIfAborted();
          const next = new Map(clear ? [] : entries);
          for (const [key, value] of changes) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return localEntries.parse([...next]);
        }, signal);
      } catch (error) {
        localWrittenBytes -= bytes;
        throw error;
      }
    },
  });
  return composeHostPlugins([storage, localStorage], { grantedCapabilities: [capability] });
}
