import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_MAX_REQUESTS_PER_SECOND = 30;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
export const DEFAULT_MAX_REQUEST_IDS = 10_000;
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const bridgeIdSchema = z.string().min(1).max(128);
export const bridgeMethodNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][A-Za-z0-9._-]*$/);
export const bridgeErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(256),
  })
  .strict();

export const bridgeInitSchema = z
  .object({
    type: z.literal("sandbox:init"),
    version: protocolVersionSchema,
    capabilities: z.array(z.string().max(128)).max(256),
    maxPayloadBytes: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger, "must be a safe integer"),
  })
  .strict();

export const bridgeReadySchema = z
  .object({
    type: z.literal("sandbox:ready"),
    version: protocolVersionSchema,
  })
  .strict();

export const bridgeRequestSchema = z
  .object({
    type: z.literal("request"),
    version: protocolVersionSchema,
    id: bridgeIdSchema,
    method: bridgeMethodNameSchema,
    payload: z.unknown(),
  })
  .strict()
  .superRefine(requireOwnPayload);

export const bridgeCancelSchema = z
  .object({
    type: z.literal("cancel"),
    version: protocolVersionSchema,
    id: bridgeIdSchema,
  })
  .strict();

export const bridgeResponseSchema = z.union([
  z
    .object({
      type: z.literal("response"),
      version: protocolVersionSchema,
      id: bridgeIdSchema,
      ok: z.literal(true),
      payload: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("response"),
      version: protocolVersionSchema,
      id: bridgeIdSchema,
      ok: z.literal(false),
      error: bridgeErrorSchema,
    })
    .strict(),
]);

export const bridgeEventSchema = z
  .object({
    type: z.literal("event"),
    version: protocolVersionSchema,
    name: bridgeMethodNameSchema,
    payload: z.unknown(),
  })
  .strict()
  .superRefine(requireOwnPayload);

export type BridgeMessageType =
  | "sandbox:init"
  | "sandbox:ready"
  | "request"
  | "response"
  | "event"
  | "cancel";

export type BridgeErrorPayload = z.infer<typeof bridgeErrorSchema>;
export type BridgeInitMessage = z.infer<typeof bridgeInitSchema>;
export type BridgeReadyMessage = z.infer<typeof bridgeReadySchema>;
export type BridgeRequestMessage = z.infer<typeof bridgeRequestSchema>;
export type BridgeCancelMessage = z.infer<typeof bridgeCancelSchema>;
export type BridgeResponseMessage = z.infer<typeof bridgeResponseSchema>;
export type BridgeEventMessage = z.infer<typeof bridgeEventSchema>;

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
  return protocolVersionSchema.safeParse(value).success;
}

export function isBridgeReadyMessage(value: unknown): value is BridgeReadyMessage {
  return bridgeReadySchema.safeParse(value).success;
}

export function isBridgeInitMessage(value: unknown): value is BridgeInitMessage {
  return bridgeInitSchema.safeParse(value).success;
}

export function isBridgeRequestMessage(value: unknown): value is BridgeRequestMessage {
  return bridgeRequestSchema.safeParse(value).success;
}

export function isBridgeCancelMessage(value: unknown): value is BridgeCancelMessage {
  return bridgeCancelSchema.safeParse(value).success;
}

export function isBridgeResponseMessage(value: unknown): value is BridgeResponseMessage {
  return bridgeResponseSchema.safeParse(value).success;
}

export function isBridgeEventMessage(value: unknown): value is BridgeEventMessage {
  return bridgeEventSchema.safeParse(value).success;
}

export function isValidId(value: unknown): value is string {
  return bridgeIdSchema.safeParse(value).success;
}

export function isValidMethodName(value: unknown): value is string {
  return bridgeMethodNameSchema.safeParse(value).success;
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

function requireOwnPayload(
  value: { readonly payload?: unknown },
  context: z.RefinementCtx,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, "payload")) {
    context.addIssue({
      code: "custom",
      message: "payload is required",
      path: ["payload"],
    });
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
