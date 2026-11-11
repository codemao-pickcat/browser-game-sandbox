import { acceptSandboxBridge, type BridgeCallOptions, type SandboxBridgeClient } from "./client.js";
import { SandboxBridgeError } from "./errors.js";
import { parseSandboxGamePreloadConfig, type SandboxGamePreloadConfig } from "./game-api-config.js";
import { DEFAULT_MAX_PAYLOAD_BYTES, estimatePayloadBytes } from "./protocol.js";
import type { GameWindowLike } from "./transport.js";

export type SandboxGameApi = Readonly<Record<string,
  (payload: unknown, options?: BridgeCallOptions) => Promise<unknown>
>>;

export interface InstallSandboxGameApiOptions extends SandboxGamePreloadConfig {
  readonly window?: GameWindowLike;
}

type BridgeWaiter = {
  resolve(bridge: SandboxBridgeClient): void;
  reject(error: unknown): void;
};

/**
 * Synchronously installs window.game; each explicit method awaits the private
 * bridge. Only host-side validation/authorization is a security authority.
 * Call timeouts include time waiting for the handshake, with a bounded queue.
 */
export function installSandboxGameApi(options: InstallSandboxGameApiOptions): SandboxGameApi {
  const { window: target = globalThis.window, ...value } = options;
  const config = parseSandboxGamePreloadConfig(value);
  if (!target) throw new TypeError("Game API preload requires a browser window");
  if ("game" in target) throw new TypeError("window.game already exists");

  const api: Record<string, SandboxGameApi[string]> = Object.create(null);
  const waiters = new Set<BridgeWaiter>();
  const maxQueuedCalls = config.maxQueuedCalls ?? 64;
  const maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  let outcome: { client: SandboxBridgeClient } | { error: unknown } | undefined;

  function acquire(timeoutMs: number, signal?: AbortSignal): Promise<SandboxBridgeClient> {
    if (outcome) return "client" in outcome ? Promise.resolve(outcome.client) : Promise.reject(outcome.error);
    if (waiters.size >= maxQueuedCalls) {
      return Promise.reject(new SandboxBridgeError("RATE_LIMITED", "Game API handshake queue is full"));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: BridgeWaiter = {
        resolve(client) { cleanup(); resolve(client); },
        reject(error) { cleanup(); reject(error); },
      };
      const onAbort = () => waiter.reject(new SandboxBridgeError("CANCELLED", "Call was cancelled"));
      const timer = setTimeout(() => {
        waiter.reject(new SandboxBridgeError("TIMEOUT", "Call timed out waiting for the bridge"));
      }, timeoutMs);
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  for (const [name, { method, defaultTimeoutMs }] of Object.entries(config.methods)) {
    api[name] = async (payload, callOptions = {}) => {
      const timeoutMs = callOptions.timeoutMs ?? defaultTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new SandboxBridgeError("INVALID_MESSAGE", "timeoutMs must be positive");
      }
      if (callOptions.signal?.aborted) {
        throw new SandboxBridgeError("CANCELLED", "Call was cancelled");
      }
      if (estimatePayloadBytes(payload, maxPayloadBytes) > maxPayloadBytes) {
        throw new SandboxBridgeError("INVALID_PAYLOAD", "Payload exceeds the configured limit");
      }
      const started = Date.now();
      const bridge = await acquire(timeoutMs, callOptions.signal);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new SandboxBridgeError("TIMEOUT", "Call timed out waiting for the bridge");
      return bridge.call(method, payload, { ...callOptions, timeoutMs: remaining });
    };
  }

  Object.freeze(api);
  Object.defineProperty(target, "game", { value: api, enumerable: true, writable: false, configurable: false });
  const { methods: _methods, maxQueuedCalls: _maxQueuedCalls, ...bridgeConfig } = config;
  // One settlement observer, not one Promise.then per queued call: cancelled
  // and timed-out waiters immediately release payloads and all subscriptions.
  void acceptSandboxBridge({ window: target, ...bridgeConfig }).then(
    (client) => {
      outcome = { client };
      for (const waiter of waiters) waiter.resolve(client);
    },
    (error: unknown) => {
      outcome = { error };
      for (const waiter of waiters) waiter.reject(error);
    },
  );
  return api;
}
