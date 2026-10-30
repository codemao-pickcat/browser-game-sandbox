export interface MessagePortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  start?(): void;
  close(): void;
}

export interface MessageTargetLike {
  postMessage(
    message: unknown,
    targetOrigin: string,
    transfer?: readonly Transferable[],
  ): void;
}

export interface HostMessageEventLike {
  readonly data: unknown;
  readonly origin: string;
  readonly source: MessageTargetLike | null;
  readonly ports: readonly MessagePortLike[];
}

export interface HostWindowLike {
  readonly location?: { readonly origin: string };
  addEventListener(
    type: "message",
    listener: (event: HostMessageEventLike) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: HostMessageEventLike) => void,
  ): void;
}

export interface GameWindowLike extends HostWindowLike {
  readonly parent: MessageTargetLike;
}

export interface IframeLike {
  readonly contentWindow: MessageTargetLike | null;
  readonly remove?: () => void;
}

export interface MessageChannelLike {
  readonly port1: MessagePortLike;
  readonly port2: MessagePortLike;
}

export type MessageChannelFactory = () => MessageChannelLike;

export function browserMessageChannelFactory(): MessageChannelLike {
  const channel = new MessageChannel();
  return { port1: channel.port1, port2: channel.port2 };
}
