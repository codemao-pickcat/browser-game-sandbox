export type BridgeErrorCode =
  | "BRIDGE_CLOSED"
  | "CANCELLED"
  | "TIMEOUT"
  | "INVALID_MESSAGE"
  | "INVALID_PAYLOAD"
  | "NOT_ALLOWED"
  | "UNKNOWN_METHOD"
  | "RATE_LIMITED"
  | "DUPLICATE_REQUEST"
  | "INTERNAL_ERROR";

export class SandboxBridgeError extends Error {
  public readonly code: BridgeErrorCode | string;

  public constructor(code: BridgeErrorCode | string, message: string) {
    super(message);
    this.name = "SandboxBridgeError";
    this.code = code;
  }
}

export class BridgeClosedError extends SandboxBridgeError {
  public constructor(message = "Sandbox bridge is closed") {
    super("BRIDGE_CLOSED", message);
    this.name = "BridgeClosedError";
  }
}
