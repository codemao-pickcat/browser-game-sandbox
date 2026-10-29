export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_MAX_REQUESTS_PER_SECOND = 30;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
export const DEFAULT_MAX_REQUEST_IDS = 10_000;
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export type BridgeMessageType =
  | "sandbox:init"
  | "sandbox:ready"
  | "request"
  | "response"
  | "event"
  | "cancel";

export interface BridgeInitMessage {
  readonly type: "sandbox:init";
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly maxPayloadBytes: number;
}

export interface BridgeReadyMessage {
  readonly type: "sandbox:ready";
  readonly version: number;
}

export interface BridgeRequestMessage {
  readonly type: "request";
  readonly version: number;
  readonly id: string;
  readonly method: string;
  readonly payload: unknown;
}

export interface BridgeCancelMessage {
  readonly type: "cancel";
  readonly version: number;
  readonly id: string;
}

export interface BridgeErrorPayload {
  readonly code: string;
  readonly message: string;
}

export type BridgeResponseMessage =
  | {
      readonly type: "response";
      readonly version: number;
      readonly id: string;
      readonly ok: true;
      readonly payload?: unknown;
      readonly error?: never;
    }
  | {
      readonly type: "response";
      readonly version: number;
      readonly id: string;
      readonly ok: false;
      readonly payload?: never;
      readonly error: BridgeErrorPayload;
    };

export interface BridgeEventMessage {
  readonly type: "event";
  readonly version: number;
  readonly name: string;
  readonly payload: unknown;
}

export type BridgePortMessage =
  | BridgeReadyMessage
  | BridgeRequestMessage
  | BridgeCancelMessage
  | BridgeResponseMessage
  | BridgeEventMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isProtocolVersion(value: unknown): value is number {
  return value === PROTOCOL_VERSION;
}

export function isBridgeReadyMessage(value: unknown): value is BridgeReadyMessage {
  return (
    isRecord(value) &&
    value.type === "sandbox:ready" &&
    isProtocolVersion(value.version)
  );
}

export function isBridgeInitMessage(value: unknown): value is BridgeInitMessage {
  return (
    isRecord(value) &&
    value.type === "sandbox:init" &&
    isProtocolVersion(value.version) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string") &&
    typeof value.maxPayloadBytes === "number" &&
    Number.isSafeInteger(value.maxPayloadBytes) &&
    value.maxPayloadBytes > 0
  );
}

export function isBridgeRequestMessage(value: unknown): value is BridgeRequestMessage {
  return (
    isRecord(value) &&
    value.type === "request" &&
    isProtocolVersion(value.version) &&
    isValidId(value.id) &&
    isValidMethodName(value.method) &&
    "payload" in value
  );
}

export function isBridgeCancelMessage(value: unknown): value is BridgeCancelMessage {
  return (
    isRecord(value) &&
    value.type === "cancel" &&
    isProtocolVersion(value.version) &&
    isValidId(value.id)
  );
}

export function isBridgeResponseMessage(value: unknown): value is BridgeResponseMessage {
  return (
    isRecord(value) &&
    value.type === "response" &&
    isProtocolVersion(value.version) &&
    isValidId(value.id) &&
    typeof value.ok === "boolean" &&
    (value.ok
      ? !("error" in value)
      : !("payload" in value) &&
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string")
  );
}

export function isBridgeEventMessage(value: unknown): value is BridgeEventMessage {
  return (
    isRecord(value) &&
    value.type === "event" &&
    isProtocolVersion(value.version) &&
    isValidMethodName(value.name) &&
    "payload" in value
  );
}

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function isValidMethodName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[a-z][A-Za-z0-9._-]*$/.test(value)
  );
}

export function assertValidOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) {
    throw new TypeError(`Expected an exact http(s) origin, received: ${origin}`);
  }
}

export function estimatePayloadBytes(value: unknown): number {
  try {
    return measurePayload(value, new WeakSet<object>(), 0);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function measurePayload(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): number {
  if (depth > 64) return Number.POSITIVE_INFINITY;
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 8;
  if (typeof value === "bigint") return 16;
  if (typeof value !== "object") return Number.POSITIVE_INFINITY;

  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  seen.add(value);

  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof Date || value instanceof RegExp) {
    return new TextEncoder().encode(String(value)).byteLength;
  }

  if (value instanceof Map) {
    let total = 0;
    for (const [key, entry] of value) {
      total += measurePayload(key, seen, depth + 1);
      total += measurePayload(entry, seen, depth + 1);
    }
    return total;
  }

  if (value instanceof Set) {
    let total = 0;
    for (const entry of value) total += measurePayload(entry, seen, depth + 1);
    return total;
  }

  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += measurePayload(entry, seen, depth + 1);
    return total;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return Number.POSITIVE_INFINITY;
  }

  let total = 0;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    total += new TextEncoder().encode(key).byteLength;
    total += measurePayload(record[key], seen, depth + 1);
  }
  return total;
}
