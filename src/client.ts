import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  isBridgeEventMessage,
  isBridgeInitMessage,
  isBridgeResponseMessage,
  isValidMethodName,
  estimatePayloadBytes,
  assertValidOrigin,
  PROTOCOL_VERSION,
  type BridgeEventMessage,
  type BridgeResponseMessage,
} from "./protocol.js";
import { BridgeClosedError, SandboxBridgeError } from "./errors.js";
import type { GameWindowLike, MessagePortLike } from "./transport.js";

export interface BridgeCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SandboxBridgeClientOptions {
  readonly maxPayloadBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly idFactory?: () => string;
}

export interface AcceptSandboxBridgeOptions extends SandboxBridgeClientOptions {
  readonly window: GameWindowLike;
  readonly expectedHostOrigin: string;
  readonly handshakeTimeoutMs?: number;
}

type PendingCall = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abortHandler: (() => void) | undefined;
};

type EventHandler = (payload: unknown) => void;

export class SandboxBridgeClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly maxPayloadBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly idFactory: () => string;
  private closed = false;

  public constructor(
    private readonly port: MessagePortLike,
    options: SandboxBridgeClientOptions = {},
  ) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes <= 0) {
      throw new TypeError("maxPayloadBytes must be a positive safe integer");
    }
    if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new TypeError("defaultTimeoutMs must be positive");
    }
    this.idFactory = options.idFactory ?? defaultId;
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.onmessageerror = () => this.close("MessagePort reported an error");
    this.port.start?.();
  }

  public sendReady(): void {
    this.ensureOpen();
    this.port.postMessage({
      type: "sandbox:ready",
      version: PROTOCOL_VERSION,
    });
  }

  public call<T>(
    method: string,
    payload: unknown,
    options: BridgeCallOptions = {},
  ): Promise<T> {
    this.ensureOpen();

    if (!isValidMethodName(method)) {
      return Promise.reject(
        new SandboxBridgeError("INVALID_MESSAGE", `Invalid method name: ${method}`),
      );
    }

    const payloadBytes = estimatePayloadBytes(payload);
    if (payloadBytes > this.maxPayloadBytes) {
      return Promise.reject(
        new SandboxBridgeError(
          "INVALID_PAYLOAD",
          `Payload exceeds ${this.maxPayloadBytes} bytes`,
        ),
      );
    }

    let id: string;
    try {
      id = this.nextUniqueId();
    } catch (error) {
      return Promise.reject(
        error instanceof SandboxBridgeError
          ? error
          : new SandboxBridgeError("INVALID_MESSAGE", "Unable to allocate request ID"),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new SandboxBridgeError("INVALID_MESSAGE", "timeoutMs must be positive"),
      );
    }

    if (options.signal?.aborted) {
      return Promise.reject(new SandboxBridgeError("CANCELLED", "Call was cancelled"));
    }

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const abortHandler = options.signal
        ? () => {
            this.finishPending(
              id,
              new SandboxBridgeError("CANCELLED", "Call was cancelled"),
            );
            this.postCancel(id);
          }
        : undefined;

      timer = setTimeout(() => {
        this.finishPending(
          id,
          new SandboxBridgeError("TIMEOUT", `Call timed out after ${timeoutMs}ms`),
        );
        this.postCancel(id);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal: options.signal,
        abortHandler,
      });

      if (options.signal && abortHandler) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        this.port.postMessage({
          type: "request",
          version: PROTOCOL_VERSION,
          id,
          method,
          payload,
        });
      } catch (error) {
        this.finishPending(
          id,
          new SandboxBridgeError(
            "BRIDGE_CLOSED",
            error instanceof Error ? error.message : "Unable to send request",
          ),
        );
      }
    });
  }

  public on(name: string, handler: EventHandler): () => void {
    if (!isValidMethodName(name)) {
      throw new SandboxBridgeError("INVALID_MESSAGE", `Invalid event name: ${name}`);
    }

    const handlers = this.eventHandlers.get(name) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(name, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.eventHandlers.delete(name);
    };
  }

  public close(reason = "Sandbox bridge is closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.port.close();

    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending);
      pending.reject(new BridgeClosedError(reason));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }

  private handleMessage(message: unknown): void {
    if (this.closed) return;

    if (isBridgeResponseMessage(message)) {
      const responseSize = message.ok
        ? estimatePayloadBytes(message.payload)
        : estimatePayloadBytes(message.error);
      if (responseSize > this.maxPayloadBytes) {
        this.close("Inbound response exceeded the payload limit");
        return;
      }
      this.handleResponse(message);
      return;
    }

    if (isBridgeEventMessage(message)) {
      if (estimatePayloadBytes(message.payload) > this.maxPayloadBytes) {
        this.close("Inbound event exceeded the payload limit");
        return;
      }
      this.handleEvent(message);
    }
  }

  private handleResponse(message: BridgeResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.clearPending(message.id, pending);
    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      pending.reject(
        new SandboxBridgeError(message.error.code, message.error.message),
      );
    }
  }

  private handleEvent(message: BridgeEventMessage): void {
    const handlers = this.eventHandlers.get(message.name);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch {
          // A game event handler must not prevent bridge cleanup or other handlers.
        }
      }
    }
    if (message.name === "sandbox.terminated") {
      const reason =
        message.payload && typeof message.payload === "object" && "reason" in message.payload
          ? String((message.payload as { readonly reason?: unknown }).reason ?? "Sandbox terminated")
          : "Sandbox terminated";
      this.close(reason);
    }
  }

  private postCancel(id: string): void {
    if (this.closed) return;
    try {
      this.port.postMessage({ type: "cancel", version: PROTOCOL_VERSION, id });
    } catch {
      // The original call already has its terminal error.
    }
  }

  private finishPending(id: string, reason: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.clearPending(id, pending);
    pending.reject(reason);
  }

  private clearPending(id: string, pending: PendingCall): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    this.pending.delete(id);
  }

  private nextUniqueId(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = this.idFactory();
      if (!this.pending.has(id)) return id;
    }
    throw new SandboxBridgeError("INVALID_MESSAGE", "Unable to allocate a unique request ID");
  }

  private ensureOpen(): void {
    if (this.closed) throw new BridgeClosedError();
  }
}

export function acceptSandboxBridge(
  options: AcceptSandboxBridgeOptions,
): Promise<SandboxBridgeClient> {
  const {
    window,
    expectedHostOrigin,
    handshakeTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    ...clientOptions
  } = options;
  if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new TypeError("handshakeTimeoutMs must be positive");
  }
  assertValidOrigin(expectedHostOrigin);

  return new Promise<SandboxBridgeClient>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", listener);
      reject(new SandboxBridgeError("TIMEOUT", "Sandbox bridge handshake timed out"));
    }, handshakeTimeoutMs);

    const listener = (event: { readonly data: unknown; readonly origin: string; readonly source: unknown; readonly ports: readonly MessagePortLike[] }) => {
      if (settled) return;
      if (event.origin !== expectedHostOrigin || event.source !== window.parent) return;
      if (!isBridgeInitMessage(event.data)) return;

      if (event.ports.length !== 1) return;
      const port = event.ports[0];
      if (!port) return;

      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      try {
        const client = new SandboxBridgeClient(port, {
          ...clientOptions,
          maxPayloadBytes: event.data.maxPayloadBytes,
        });
        client.sendReady();
        resolve(client);
      } catch (error) {
        port.close();
        reject(
          error instanceof SandboxBridgeError
            ? error
            : new SandboxBridgeError("BRIDGE_CLOSED", "Unable to complete bridge handshake"),
        );
      }
    };

    window.addEventListener("message", listener);
    try {
      window.parent.postMessage(
        { type: "sandbox:ready", version: PROTOCOL_VERSION },
        expectedHostOrigin,
      );
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      reject(
        error instanceof SandboxBridgeError
          ? error
          : new SandboxBridgeError("BRIDGE_CLOSED", "Unable to announce sandbox readiness"),
      );
    }
  });
}

function defaultId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
