export const SANDBOX_STORAGE_LIMITS = Object.freeze({
  keyBytes: 128,
  valueBytes: 16 * 1024,
  sessionWriteBytes: 1024 * 1024,
  sessionWriteKeys: 128,
  localStorageBytes: 48 * 1024,
  localStorageEntries: 128,
});

export const LOCAL_STORAGE_BATCH_BYTES = 60 * 1024;
export const LOCAL_STORAGE_BATCH_ENTRIES = 2 * SANDBOX_STORAGE_LIMITS.localStorageEntries;

export type LocalStorageEntry = [string, string];

const encoder = new TextEncoder();
export function localStorageBytes(key: string, value: string | null): number {
  // Account for the two array elements and the outer entry in the bridge budget.
  return 3 + encoder.encode(key).byteLength + (value === null ? 0 : encoder.encode(value).byteLength);
}
