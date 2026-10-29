import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_REQUESTS_PER_SECOND,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_REQUEST_IDS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  assertValidOrigin,
  estimatePayloadBytes,
  isBridgeCancelMessage,
  isBridgeRequestMessage,
  isBridgeReadyMessage,
  isValidMethodName,
  type BridgeEventMessage,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
} from "./protocol.js";
import { BridgeClosedError, SandboxBridgeError } from "./errors.js";
import type {
  HostMessageEventLike,
  HostWindowLike,
  IframeLike,
  MessageChannelFactory,
  MessagePortLike,
} from "./transport.js";
import { browserMessageChannelFactory } from "./transport.js";

export interface HostMethodContext {
  readonly signal: AbortSignal;
  readonly capabilities: readonly string[];
  readonly requestId: string;
  readonly methodName: string;
}

export interface HostMethodDefinition {
  readonly capability?: string;
  readonly maxPayloadBytes?: number;
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  readonly validate?: (payload: unknown) => void;
  readonly handler: (payload: unknown, context: HostMethodContext) => unknown | Promise<unknown>;
}

export interface SandboxHostOptions {
  readonly window: HostWindowLike;
  readonly iframe: IframeLike;
  readonly gameOrigin: string;
  readonly capabilities?: readonly string[];
  readonly methods?: Readonly<Record<string, HostMethodDefinition>>;
  readonly maxPayloadBytes?: number;
  readonly maxRequestsPerSecond?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxRequestIds?: number;
  readonly handshakeTimeoutMs?: number;
  readonly channelFactory?: MessageChannelFactory;
  readonly onRequestClose?: (reason: string) => void;
  readonly onTerminate?: (reason: string) => void;
}

export type SandboxHostState = "idle" | "handshaking" | "connected" | "terminated";

export class SandboxHostSession {
  public readonly connected: Promise<void>;
  public state: SandboxHostState = "idle";

  private readonly capabilities: readonly string[];
  private readonly methods: ReadonlyMap<string, HostMethodDefinition>;
  private readonly maxPayloadBytes: number;
  private readonly maxRequestsPerSecond: number;
  private readonly maxConcurrentRequests: number;
  private readonly maxRequestIds: number;
  private readonly channelFactory: MessageChannelFactory;
  private readonly onMessage = (event: HostMessageEventLike) =>
    this.handleWindowMessage(event);
  private readonly requestControllers = new Map<string, AbortController>();
  private readonly activeMethodRequests = new Map<string, number>();
  private readonly seenRequestIds = new Set<string>();
  private readonly requestTimestamps: number[] = [];
  private readonly handshakeTimeoutMs: number;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resolveConnected: () => void;
  private readonly rejectConnected: (reason: unknown) => void;
  private port: MessagePortLike | undefined;
  private connectedSettled = false;

  public constructor(private readonly options: SandboxHostOptions) {
    assertValidOrigin(options.gameOrigin);
    this.capabilities = [...(options.capabilities ?? [])];
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxRequestsPerSecond =
      options.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND;
    this.maxConcurrentRequests =
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.maxRequestIds = options.maxRequestIds ?? DEFAULT_MAX_REQUEST_IDS;
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes <= 0) {
      throw new TypeError("maxPayloadBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxRequestsPerSecond) || this.maxRequestsPerSecond <= 0) {
      throw new TypeError("maxRequestsPerSecond must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxConcurrentRequests) || this.maxConcurrentRequests <= 0) {
      throw new TypeError("maxConcurrentRequests must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxRequestIds) || this.maxRequestIds <= 0) {
      throw new TypeError("maxRequestIds must be a positive safe integer");
    }
    if (!Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      throw new TypeError("handshakeTimeoutMs must be positive");
    }
    this.channelFactory = options.channelFactory ?? browserMessageChannelFactory;

    let resolveConnected!: () => void;
    let rejectConnected!: (reason: unknown) => void;
    this.connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    this.resolveConnected = resolveConnected;
    this.rejectConnected = rejectConnected;

    const builtins: Record<string, HostMethodDefinition> = {
      "sandbox.getCapabilities": {
        handler: () => ({ capabilities: this.capabilities }),
      },
      "sandbox.getInfo": {
        handler: () => ({ protocolVersion: PROTOCOL_VERSION }),
      },
      "sandbox.ping": {
        handler: () => ({ ok: true }),
      },
      "sandbox.requestClose": {
        validate: validateClosePayload,
        handler: (payload) => {
          const reason = readCloseReason(payload);
          this.options.onRequestClose?.(reason);
          return { accepted: true };
        },
      },
    };

    const allMethods = new Map<string, HostMethodDefinition>();
    for (const [name, definition] of Object.entries(builtins)) {
      allMethods.set(name, definition);
    }
    for (const [name, definition] of Object.entries(options.methods ?? {})) {
      if (!isValidMethodName(name)) {
        throw new TypeError(`Invalid host method name: ${name}`);
      }
      if (allMethods.has(name)) {
        throw new TypeError(`Host method already exists: ${name}`);
      }
      assertMethodLimits(name, definition);
      allMethods.set(name, definition);
    }
    this.methods = allMethods;
  }

  public start(): void {
    if (this.state !== "idle") {
      throw new SandboxBridgeError("INVALID_MESSAGE", "Host session has already started");
    }
    this.state = "handshaking";
    this.options.window.addEventListener("message", this.onMessage);
    this.handshakeTimer = setTimeout(
      () => this.terminate("Sandbox handshake timed out"),
      this.handshakeTimeoutMs,
    );
  }

  public emit(name: string, payload: unknown): void {
    this.ensureConnected();
    if (!isValidMethodName(name)) {
      throw new SandboxBridgeError("INVALID_MESSAGE", `Invalid event name: ${name}`);
    }
    this.assertPayloadSize(payload);
    const message: BridgeEventMessage = {
      type: "event",
      version: PROTOCOL_VERSION,
      name,
      payload,
    };
    this.port!.postMessage(message);
  }

  public terminate(reason = "Sandbox terminated"): void {
    if (this.state === "terminated") return;
    this.state = "terminated";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.options.window.removeEventListener("message", this.onMessage);

    for (const controller of this.requestControllers.values()) controller.abort();
    this.requestControllers.clear();
    this.activeMethodRequests.clear();
    this.seenRequestIds.clear();

    if (this.port) {
      try {
        this.port.postMessage({
          type: "event",
          version: PROTOCOL_VERSION,
          name: "sandbox.terminated",
          payload: { reason: limitReason(reason) },
        });
      } catch {
        // The port may already be broken.
      }
      this.port.close();
      this.port = undefined;
    }

    if (!this.connectedSettled) {
      this.connectedSettled = true;
      this.rejectConnected(new BridgeClosedError(reason));
    }
    this.options.onTerminate?.(reason);
  }

  private handleWindowMessage(event: HostMessageEventLike): void {
    if (this.state !== "handshaking") return;
    if (event.origin !== this.options.gameOrigin) return;
    const source = event.source;
    if (!source || source !== this.options.iframe.contentWindow) return;
    if (!isBridgeReadyMessage(event.data)) return;
    if (this.port) return;

    let channel;
    try {
      channel = this.channelFactory();
    } catch {
      this.terminate("Unable to create MessageChannel");
      return;
    }
    this.port = channel.port1;
    this.port.onmessage = (messageEvent) =>
      this.handlePortMessage(messageEvent.data);
    this.port.onmessageerror = () => this.terminate("MessagePort reported an error");
    this.port.start?.();
    this.state = "handshaking";

    const initMessage = {
      type: "sandbox:init" as const,
      version: PROTOCOL_VERSION,
      capabilities: this.capabilities,
      maxPayloadBytes: this.maxPayloadBytes,
    };

    source.postMessage(
      initMessage,
      this.options.gameOrigin,
      [channel.port2 as unknown as Transferable],
    );
  }

  private handlePortMessage(message: unknown): void {
    if (this.state === "terminated") return;

    if (this.state === "handshaking" && isBridgeReadyMessage(message)) {
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.state = "connected";
      if (!this.connectedSettled) {
        this.connectedSettled = true;
        this.resolveConnected();
      }
      return;
    }

    if (this.state !== "connected") return;

    if (isBridgeCancelMessage(message)) {
      this.requestControllers.get(message.id)?.abort();
      return;
    }

    if (!isBridgeRequestMessage(message)) return;
    void this.handleRequest(message);
  }

  private async handleRequest(message: BridgeRequestMessage): Promise<void> {
    if (!this.port || this.state !== "connected") return;

    if (this.seenRequestIds.has(message.id)) {
      this.sendError(message.id, "DUPLICATE_REQUEST", "Request ID has already been used");
      return;
    }
    if (this.seenRequestIds.size >= this.maxRequestIds) {
      this.sendError(message.id, "RATE_LIMITED", "Request ID budget exhausted");
      return;
    }
    this.seenRequestIds.add(message.id);

    if (!this.allowRequest()) {
      this.sendError(message.id, "RATE_LIMITED", "Request rate exceeded");
      return;
    }

    if (this.requestControllers.size >= this.maxConcurrentRequests) {
      this.sendError(message.id, "RATE_LIMITED", "Concurrent request limit exceeded");
      return;
    }

    const method = this.methods.get(message.method);
    if (!method) {
      this.sendError(message.id, "UNKNOWN_METHOD", `Unknown method: ${message.method}`);
      return;
    }

    if (method.capability && !this.capabilities.includes(method.capability)) {
      this.sendError(message.id, "NOT_ALLOWED", `Capability is not enabled: ${method.capability}`);
      return;
    }

    try {
      method.validate?.(message.payload);
    } catch (error) {
      this.sendError(message.id, "INVALID_PAYLOAD", "Invalid payload");
      return;
    }

    const methodPayloadLimit = Math.min(
      this.maxPayloadBytes,
      method.maxPayloadBytes ?? this.maxPayloadBytes,
    );
    if (estimatePayloadBytes(message.payload) > methodPayloadLimit) {
      this.sendError(message.id, "INVALID_PAYLOAD", "Payload exceeds the configured limit");
      return;
    }

    const activeForMethod = this.activeMethodRequests.get(message.method) ?? 0;
    if (method.maxConcurrent !== undefined && activeForMethod >= method.maxConcurrent) {
      this.sendError(message.id, "RATE_LIMITED", "Method concurrency limit exceeded");
      return;
    }

    const controller = new AbortController();
    this.requestControllers.set(message.id, controller);
    this.activeMethodRequests.set(message.method, activeForMethod + 1);
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const handlerPromise = method.handler(message.payload, {
        signal: controller.signal,
        capabilities: this.capabilities,
        requestId: message.id,
        methodName: message.method,
      });
      const payload = await (method.timeoutMs === undefined
        ? handlerPromise
        : Promise.race([
            handlerPromise,
            new Promise<never>((_, reject) => {
              timeoutTimer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new SandboxBridgeError("TIMEOUT", "Host method timed out"));
              }, method.timeoutMs);
            }),
          ]));
      if (estimatePayloadBytes(payload) > methodPayloadLimit) {
        this.sendError(message.id, "INVALID_PAYLOAD", "Response exceeds the configured limit");
        return;
      }
      this.sendResponse({
        type: "response",
        version: PROTOCOL_VERSION,
        id: message.id,
        ok: true,
        payload,
      });
    } catch {
      this.sendError(
        message.id,
        timedOut ? "TIMEOUT" : "INTERNAL_ERROR",
        timedOut ? "Host method timed out" : "Host method failed",
      );
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.requestControllers.delete(message.id);
      const remaining = (this.activeMethodRequests.get(message.method) ?? 1) - 1;
      if (remaining > 0) this.activeMethodRequests.set(message.method, remaining);
      else this.activeMethodRequests.delete(message.method);
    }
  }

  private sendResponse(response: BridgeResponseMessage): void {
    if (this.state !== "connected" || !this.port) return;
    try {
      this.port.postMessage(response);
    } catch {
      this.terminate("MessagePort could not send a response");
    }
  }

  private sendError(id: string, code: string, message: string): void {
    this.sendResponse({
      type: "response",
      version: PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message: limitReason(message) },
    });
  }

  private allowRequest(): boolean {
    const now = Date.now();
    while (this.requestTimestamps[0] !== undefined && now - this.requestTimestamps[0] >= 1_000) {
      this.requestTimestamps.shift();
    }
    if (this.requestTimestamps.length >= this.maxRequestsPerSecond) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  private assertPayloadSize(payload: unknown): void {
    if (estimatePayloadBytes(payload) > this.maxPayloadBytes) {
      throw new SandboxBridgeError("INVALID_PAYLOAD", "Payload exceeds the configured limit");
    }
  }

  private ensureConnected(): void {
    if (this.state !== "connected" || !this.port) {
      throw new BridgeClosedError("Sandbox is not connected");
    }
  }
}

function assertMethodLimits(name: string, method: HostMethodDefinition): void {
  if (method.maxPayloadBytes !== undefined &&
      (!Number.isSafeInteger(method.maxPayloadBytes) || method.maxPayloadBytes <= 0)) {
    throw new TypeError(`Invalid maxPayloadBytes for method: ${name}`);
  }
  if (method.maxConcurrent !== undefined &&
      (!Number.isSafeInteger(method.maxConcurrent) || method.maxConcurrent <= 0)) {
    throw new TypeError(`Invalid maxConcurrent for method: ${name}`);
  }
  if (method.timeoutMs !== undefined &&
      (!Number.isFinite(method.timeoutMs) || method.timeoutMs <= 0)) {
    throw new TypeError(`Invalid timeoutMs for method: ${name}`);
  }
}

function validateClosePayload(payload: unknown): void {
  if (payload === undefined || payload === null) return;
  if (typeof payload !== "object") throw new TypeError("Close payload must be an object");
}

function readCloseReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Requested by game";
  const reason = (payload as { readonly reason?: unknown }).reason;
  return typeof reason === "string" ? limitReason(reason) : "Requested by game";
}

function limitReason(reason: string): string {
  return reason.slice(0, 256);
}
