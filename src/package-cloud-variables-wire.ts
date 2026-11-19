import { z } from "zod";
import type { BridgeCallOptions, SandboxBridgeClient } from "./client.js";
import { SandboxBridgeError } from "./errors.js";
import type { SandboxGameApiBinding } from "./game-api-config.js";

export const SANDBOX_CLOUD_PAYLOAD_BYTES = 32_768;

export type SandboxCloudValue = null | boolean | number | string | SandboxCloudValue[] | { [key: string]: SandboxCloudValue };

const encoder = new TextEncoder();
const validText = (value: string): boolean => !/[\u0000\uD800-\uDFFF]/u.test(value);
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const key = z.string().min(1).max(64).refine(value => encoder.encode(value).byteLength <= 64);
const cursor = z.string().min(1);
const rev = z.number().int().nonnegative();
const value = z.custom<SandboxCloudValue>(value => value !== undefined);
const includeLimits = z.array(name).max(8).refine(names => new Set(names).size === names.length);

export const cloudGetRequest = z.strictObject({
  name,
  key: key.optional(),
  self: z.literal(true).optional(),
  limit: z.number().int().min(1).max(64).optional(),
  cursor: cursor.optional(),
  includeLimits: includeLimits.optional(),
}).refine(({ key, self, limit, cursor }) =>
  (key === undefined && self === undefined) ||
  ((key === undefined || self === undefined) && limit === undefined && cursor === undefined),
);

const requestId = z.string().regex(/^[1-9]\d{0,15}\.[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i)
  .refine(id => Number.isSafeInteger(Number(id.slice(0, id.indexOf(".")))));
const write = { name, requestId, ifRev: rev.optional() };
const index = z.number().int().nonnegative();
export const cloudApplyRequest = z.discriminatedUnion("op", [
  z.strictObject({ ...write, op: z.literal("set"), arg: z.strictObject({ value }), ifRev: rev }),
  z.strictObject({ ...write, op: z.literal("increment"), arg: z.strictObject({ by: z.number() }) }),
  z.strictObject({ ...write, op: z.literal("append"), arg: z.strictObject({ value }) }),
  z.strictObject({ ...write, op: z.literal("replaceAt"), arg: z.strictObject({ index, value }), ifRev: rev }),
  z.strictObject({ ...write, op: z.literal("removeAt"), arg: z.strictObject({ index }), ifRev: rev }),
  z.strictObject({ ...write, op: z.literal("put"), arg: z.strictObject({ key: key.optional(), value }) }),
  z.strictObject({ ...write, op: z.literal("remove"), arg: z.strictObject({ key: key.optional() }) }),
]);

const resetTime = z.iso.datetime().max(30).nullable();
const limitEntry = z.strictObject({ remaining: z.number().int().min(0).max(1_000_000), resetAt: resetTime });
const limitStatus = z.record(name, limitEntry).refine(status => Object.keys(status).length <= 8);
export const cloudGetResult = z.union([
  z.strictObject({ value, rev, limitStatus: limitStatus.optional() }),
  z.strictObject({ items: z.array(value).max(64), rev, nextCursor: cursor.nullable(), limitStatus: limitStatus.optional() }),
]);
export const cloudApplyResult = z.strictObject({ changed: z.boolean(), rev });

export type SandboxCloudGetRequest = z.infer<typeof cloudGetRequest>;
export type SandboxCloudApplyRequest = z.infer<typeof cloudApplyRequest>;
export type SandboxCloudGetResult = z.infer<typeof cloudGetResult>;
export type SandboxCloudApplyResult = z.infer<typeof cloudApplyResult>;

const errorMessages = Object.freeze({
  INVALID_ARGUMENT: "Invalid cloud variable argument",
  OP_NOT_ALLOWED: "The cloud operation is not enabled for this variable",
  RULE_DENIED: "The cloud operation was denied by a write rule",
  LIMIT_REACHED: "The cloud operation reached its usage limit",
  CAPACITY_EXCEEDED: "The cloud collection is full",
  QUOTA_EXCEEDED: "The cloud storage quota was exceeded",
  REV_CONFLICT: "The cloud variable revision changed",
  SCHEMA_CHANGED: "The cloud variable schema changed",
  MIGRATING: "Cloud variables are being migrated",
  VARIABLE_WRITE_PAUSED: "Writes to the cloud variable are paused",
  IDEMPOTENCY_CONFLICT: "The request ID was previously used with different arguments",
  REQUEST_EXPIRED: "The cloud request ID expired",
  PLAYBACK_LOGIN_REQUIRED: "Sign in to use cloud variables",
  PLAYBACK_NOT_AUTHORIZED: "Cloud variable playback access was denied",
  PLAYBACK_SESSION_EXPIRED: "Cloud variable playback access expired",
  UNAUTHORIZED: "Cloud variable access was denied",
  NOT_FOUND: "The cloud variable or playback is unavailable",
  UNAVAILABLE: "The cloud service is temporarily unavailable",
  RATE_LIMITED: "Too many cloud operations are in progress",
});

export type SandboxCloudErrorCode = keyof typeof errorMessages;

export function isCloudErrorCode(code: string): code is SandboxCloudErrorCode {
  return Object.hasOwn(errorMessages, code);
}

/** Carries a public business code and, for a usage limit, an optional reset time. */
export class SandboxCloudVariablesError extends SandboxBridgeError {
  public declare readonly code: SandboxCloudErrorCode;
  public readonly resetAt?: string | null;

  public constructor(code: SandboxCloudErrorCode, resetAt?: string | null) {
    super(code, errorMessages[code]);
    this.name = "SandboxCloudVariablesError";
    if (code === "LIMIT_REACHED" && resetAt !== undefined && resetTime.safeParse(resetAt).success) this.resetAt = resetAt;
  }
}

const cloudErrorResult = z.strictObject({
  error: z.strictObject({
    code: z.custom<SandboxCloudErrorCode>(code => typeof code === "string" && isCloudErrorCode(code)),
    resetAt: resetTime.optional(),
  }).refine(({ code, resetAt }) => code === "LIMIT_REACHED" || resetAt === undefined),
});

/** Compact canonical JSON, with the full byte budget enforced while writing. */
export function encodeCloudPayload(input: unknown): string {
  const parts: string[] = [];
  const active = new Set<object>();
  let remaining = SANDBOX_CLOUD_PAYLOAD_BYTES;

  function add(text: string): void {
    remaining -= encoder.encode(text).byteLength;
    if (remaining < 0) throw new TypeError("Cloud payload exceeds its byte limit");
    parts.push(text);
  }

  function addString(text: string): void {
    if (text.length + 2 > remaining) throw new TypeError("Cloud payload exceeds its byte limit");
    if (!validText(text)) throw new TypeError("Cloud text contains invalid characters");
    add(JSON.stringify(text));
  }

  function writeProperty(source: object, key: string, depth: number): void {
    const property = Object.getOwnPropertyDescriptor(source, key);
    if (!property?.enumerable || !("value" in property)) throw new TypeError("Cloud values must contain JSON data properties");
    writeValue(property.value, depth + 1);
  }

  function writeValue(value: unknown, depth: number): void {
    if (depth > 16) throw new TypeError("Cloud payload is too deeply nested");
    if (typeof value === "string") return addString(value);
    if (value === null || typeof value === "boolean") return add(JSON.stringify(value));
    if (typeof value === "number" && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return add(JSON.stringify(value));
    if (typeof value !== "object" || active.has(value)) throw new TypeError("Cloud values must be JSON data");
    active.add(value);
    if (Array.isArray(value)) {
      if (value.length > remaining || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError("Invalid cloud array");
      }
      add("[");
      for (let index = 0; index < value.length; index++) {
        if (index > 0) add(",");
        writeProperty(value, String(index), depth);
      }
      add("]");
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) throw new TypeError("Cloud values must contain plain objects");
      const keys = Object.keys(value);
      if (keys.length > remaining || keys.length !== Reflect.ownKeys(value).length) throw new TypeError("Invalid cloud object");
      add("{");
      for (const [index, key] of keys.sort().entries()) {
        if (index > 0) add(",");
        addString(key);
        add(":");
        writeProperty(value, key, depth);
      }
      add("}");
    }
    active.delete(value);
  }

  writeValue(input, 0);
  return parts.join("");
}

function parseWithSchema<T>(value: unknown, schema: z.ZodType<T>): T {
  if (!schema.safeParse(value).success) throw new TypeError("Invalid cloud message shape");
  // Preserve JSON property names and nested values exactly as transmitted.
  return value as T;
}

export function decodeCloudPayload<T>(text: unknown, schema: z.ZodType<T>): T {
  if (typeof text !== "string" || text.length > SANDBOX_CLOUD_PAYLOAD_BYTES ||
      encoder.encode(text).byteLength > SANDBOX_CLOUD_PAYLOAD_BYTES) throw new TypeError("Invalid cloud payload size");
  const value: unknown = JSON.parse(text);
  // A canonical round trip also rejects duplicate keys and alternate encodings.
  if (encodeCloudPayload(value) !== text) throw new TypeError("Invalid cloud payload encoding");
  return parseWithSchema(value, schema);
}

export function encodeCloudMessage(value: unknown, schema: z.ZodType): string {
  const payload = encodeCloudPayload(value);
  parseWithSchema(JSON.parse(payload), schema);
  return payload;
}

export function createCloudGameMethod<T>(
  client: SandboxBridgeClient,
  binding: SandboxGameApiBinding,
  request: z.ZodType,
  result: z.ZodType<T>,
): (input: unknown, options?: BridgeCallOptions) => Promise<T> {
  const response = z.union([result, cloudErrorResult]);
  return async (input, options) => {
    let payload: string;
    try {
      payload = encodeCloudMessage(input, request);
    } catch {
      throw new SandboxCloudVariablesError("INVALID_ARGUMENT");
    }
    const wire = await client.call(binding.method, payload, { timeoutMs: binding.defaultTimeoutMs, ...options });
    let output: T | z.infer<typeof cloudErrorResult>;
    try {
      output = decodeCloudPayload(wire, response);
    } catch {
      throw new SandboxBridgeError("INTERNAL_ERROR", "Invalid cloud variable response");
    }
    if (typeof output === "object" && output !== null && "error" in output) {
      const { code, resetAt } = cloudErrorResult.parse(output).error;
      throw new SandboxCloudVariablesError(code, resetAt);
    }
    return output as T;
  };
}
