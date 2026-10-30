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
  assertOrigin(origin, /^https?:$/, "exact http(s) origin");
}

export function assertValidNetworkOrigin(origin: string): void {
  assertOrigin(origin, /^(https?|wss?):$/, "exact http(s)/ws(s) origin");
}

export function estimatePayloadBytes(
  value: unknown,
  maxBytes = Number.POSITIVE_INFINITY,
): number {
  try {
    if (!Number.isFinite(maxBytes) && maxBytes !== Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    if (maxBytes < 0) return Number.POSITIVE_INFINITY;
    return measurePayload(
      value,
      {
        active: new WeakSet<object>(),
        cache: new WeakMap<object, number>(),
        maxBytes,
        visitedEntries: 0,
      },
      0,
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function assertOrigin(
  origin: string,
  protocolPattern: RegExp,
  description: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`Expected an ${description}, received: ${origin}`);
  }

  if (
    parsed.origin !== origin ||
    !protocolPattern.test(parsed.protocol) ||
    !isSafeOriginHostname(parsed.hostname)
  ) {
    throw new TypeError(`Expected an ${description}, received: ${origin}`);
  }
}

function isSafeOriginHostname(hostname: string): boolean {
  if (hostname.startsWith("[")) {
    return /^\[[0-9A-Fa-f:.]+\]$/.test(hostname);
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname);
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

const payloadEncoder = new TextEncoder();
const MAX_PAYLOAD_DEPTH = 64;
const MAX_PAYLOAD_ENTRIES = 100_000;

type PayloadMeasureContext = {
  readonly active: WeakSet<object>;
  readonly cache: WeakMap<object, number>;
  readonly maxBytes: number;
  visitedEntries: number;
};

function measurePayload(
  value: unknown,
  context: PayloadMeasureContext,
  depth: number,
): number {
  if (depth > MAX_PAYLOAD_DEPTH) return Number.POSITIVE_INFINITY;
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return payloadEncoder.encode(value).byteLength;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 8;
  if (typeof value === "bigint") return 16;
  if (typeof value !== "object") return Number.POSITIVE_INFINITY;

  const cached = context.cache.get(value);
  if (cached !== undefined) return cached;
  if (context.active.has(value)) return Number.POSITIVE_INFINITY;
  context.active.add(value);

  let total: number;
  try {
    if (value instanceof ArrayBuffer) {
      total = value.byteLength;
    } else if (ArrayBuffer.isView(value)) {
      total = value.byteLength;
    } else if (typeof Blob !== "undefined" && value instanceof Blob) {
      total = value.size;
    } else if (value instanceof Date || value instanceof RegExp) {
      total = payloadEncoder.encode(String(value)).byteLength;
    } else if (value instanceof Map) {
      total = 0;
      if (value.size > MAX_PAYLOAD_ENTRIES) return Number.POSITIVE_INFINITY;
      Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
        if (!Number.isFinite(total)) return;
        total = addMeasuredValue(total, 1, context.maxBytes);
        total = addMeasuredValue(
          total,
          measurePayload(key, context, depth + 1),
          context.maxBytes,
        );
        total = addMeasuredValue(
          total,
          measurePayload(entry, context, depth + 1),
          context.maxBytes,
        );
      });
    } else if (value instanceof Set) {
      if (value.size > MAX_PAYLOAD_ENTRIES) return Number.POSITIVE_INFINITY;
      total = 0;
      Set.prototype.forEach.call(value, (entry: unknown) => {
        if (!Number.isFinite(total)) return;
        total = addMeasuredValue(total, 1, context.maxBytes);
        total = addMeasuredValue(
          total,
          measurePayload(entry, context, depth + 1),
          context.maxBytes,
        );
      });
    } else if (Array.isArray(value)) {
      if (value.length > MAX_PAYLOAD_ENTRIES) return Number.POSITIVE_INFINITY;
      total = 0;
      for (let index = 0; index < value.length; index += 1) {
        context.visitedEntries += 1;
        if (context.visitedEntries > MAX_PAYLOAD_ENTRIES) {
          return Number.POSITIVE_INFINITY;
        }
        total = addMeasuredValue(total, 1, context.maxBytes);
        if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
        if (Object.prototype.hasOwnProperty.call(value, index)) {
          total = addMeasuredValue(
            total,
            measurePayload(value[index], context, depth + 1),
            context.maxBytes,
          );
          if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
        }
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return Number.POSITIVE_INFINITY;
      }

      total = 0;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        context.visitedEntries += 1;
        if (context.visitedEntries > MAX_PAYLOAD_ENTRIES) {
          return Number.POSITIVE_INFINITY;
        }
        total = addMeasuredValue(
          total,
          payloadEncoder.encode(key).byteLength,
          context.maxBytes,
        );
        if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
        total = addMeasuredValue(
          total,
          measurePayload(record[key], context, depth + 1),
          context.maxBytes,
        );
        if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY;
      }
    }
  } finally {
    context.active.delete(value);
  }

  if (total > context.maxBytes) return Number.POSITIVE_INFINITY;
  context.cache.set(value, total);
  return total;
}

function addMeasuredValue(
  total: number,
  value: number,
  maxBytes: number,
): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  const next = total + value;
  return next > maxBytes ? Number.POSITIVE_INFINITY : next;
}
