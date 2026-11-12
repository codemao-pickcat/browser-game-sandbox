import { z } from "zod";
import { defineMethod, defineSandboxPlugin } from "./plugin.js";
import { composeHostPlugins, createHostPlugin, type ComposedHostPlugins } from "./host-plugin.js";

export interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export const SANDBOX_STORAGE_LIMITS = Object.freeze({ keyBytes: 128, valueBytes: 16 * 1024, sessionWriteBytes: 1024 * 1024, sessionWriteKeys: 128 });
const encoder = new TextEncoder();
const bounded = (bytes: number) => z.string().max(bytes).refine(value => encoder.encode(value).byteLength <= bytes);
const key = bounded(SANDBOX_STORAGE_LIMITS.keyBytes).refine(value => value.length > 0);
const value = bounded(SANDBOX_STORAGE_LIMITS.valueBytes);
const capability = "package.storage";
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
  return composeHostPlugins([createHostPlugin(contract, {
    get: async ({ key }, { signal }) => { signal.throwIfAborted(); return get(key); },
    set: async ({ key, value }, { signal }) => { charge(key, encoder.encode(value).byteLength, signal); await set(key, value); },
    delete: async ({ key }, { signal }) => { charge(key, 0, signal); await remove(key); },
  })], { grantedCapabilities: [capability] });
}
