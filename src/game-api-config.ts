import { z } from "zod";
import { assertValidOrigin, isValidMethodName } from "./protocol.js";

export interface SandboxGameApiBinding {
  readonly method: string;
  readonly defaultTimeoutMs: number;
}

/** Public name -> host method and call default. These bindings do not grant access. */
export type SandboxGameApiBindings = Readonly<Record<string, SandboxGameApiBinding>>;

export interface SandboxGamePreloadConfig {
  readonly expectedHostOrigin: string;
  readonly methods: SandboxGameApiBindings;
  readonly handshakeTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly maxQueuedCalls?: number;
}

const configSchema = z.object({
  expectedHostOrigin: z.string(),
  methods: z.record(z.string(), z.object({
    method: z.string(),
    defaultTimeoutMs: z.number().positive(),
  }).strict()),
  handshakeTimeoutMs: z.number().positive().optional(),
  maxPayloadBytes: z.number().int().positive().refine(Number.isSafeInteger).optional(),
  maxQueuedCalls: z.number().int().min(1).max(1024).optional(),
}).strict();

export function assertGameApiName(name: string): void {
  if (
    !/^[a-z][A-Za-z0-9_]{0,63}$/.test(name) ||
    ["then", "constructor", "prototype", "__proto__"].includes(name)
  ) {
    throw new TypeError(`Invalid game API name: ${name}`);
  }
}

export function parseSandboxGamePreloadConfig(value: unknown): SandboxGamePreloadConfig {
  // Check raw own keys first: record parsers may intentionally omit __proto__.
  if (value && typeof value === "object" && "methods" in value && value.methods && typeof value.methods === "object") {
    for (const name of Object.getOwnPropertyNames(value.methods)) assertGameApiName(name);
  }
  const config = configSchema.parse(value);
  assertValidOrigin(config.expectedHostOrigin);
  if (Object.keys(config.methods).length > 256) {
    throw new TypeError("Game API cannot expose more than 256 methods");
  }
  const methods: Record<string, SandboxGameApiBinding> = Object.create(null);
  for (const [name, binding] of Object.entries(config.methods)) {
    assertGameApiName(name);
    if (!isValidMethodName(binding.method)) throw new TypeError(`Invalid game API method: ${binding.method}`);
    methods[name] = Object.freeze({ ...binding });
  }
  return {
    expectedHostOrigin: config.expectedHostOrigin,
    methods: Object.freeze(methods),
    ...(config.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: config.handshakeTimeoutMs } : {}),
    ...(config.maxPayloadBytes !== undefined ? { maxPayloadBytes: config.maxPayloadBytes } : {}),
    ...(config.maxQueuedCalls !== undefined ? { maxQueuedCalls: config.maxQueuedCalls } : {}),
  };
}

/**
 * For a trusted game-resource HTML renderer, before ALL game-controlled markup.
 * The platform must serve game.preload.js at src and whitelist that resource.
 * No async/defer, inline JavaScript, referrer-derived trust or HTML rewriting.
 */
export function renderSandboxGamePreloadScript(
  options: SandboxGamePreloadConfig & { readonly src: string },
): string {
  const { src, ...value } = options;
  // Deliberately accept only unambiguous root-relative JavaScript resources.
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js$/.test(src)) {
    throw new TypeError("Game preload src must be a same-origin root-relative .js resource path");
  }
  const config = parseSandboxGamePreloadConfig(value);
  const data = escapeAttribute(JSON.stringify(config));
  return `<script src="${src}" data-sandbox-config="${data}"></script>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
