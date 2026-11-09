import {
  acceptSandboxBridge,
  type AcceptSandboxBridgeOptions,
  type BridgeCallOptions,
  type SandboxBridgeClient,
} from "./client.js";
import { createSandboxSdk, type SandboxSdk } from "./sdk.js";
import type { SandboxPluginContract } from "./plugin.js";
import type { GameWindowLike } from "./transport.js";

export type SandboxHtmlPlugins = Record<string, SandboxPluginContract>;

export interface SandboxHtmlSdkOptions<
  TPlugins extends SandboxHtmlPlugins = SandboxHtmlPlugins,
> extends Omit<AcceptSandboxBridgeOptions, "window"> {
  /** The game window. Defaults to the browser's current window. */
  readonly window?: GameWindowLike;
  /** Optional plugin contracts used to create the typed SDK facade. */
  readonly plugins?: TPlugins;
}

export type SandboxHtmlEventHandler = (payload: unknown) => void;

/**
 * The no-build browser-facing facade for an HTML game.
 *
 * The bridge remains available for untyped calls and events while `sdk`
 * provides the same schema-validated typed facade as `createSandboxSdk`.
 */
export interface SandboxHtmlSdk<
  TPlugins extends SandboxHtmlPlugins = SandboxHtmlPlugins,
> {
  readonly bridge: SandboxBridgeClient;
  readonly sdk: SandboxSdk<TPlugins>;
  call<T>(method: string, payload: unknown, options?: BridgeCallOptions): Promise<T>;
  on(name: string, handler: SandboxHtmlEventHandler): () => void;
  close(reason?: string): void;
}

/**
 * Accepts the host bridge from a plain HTML game page.
 *
 * `expectedHostOrigin` is deliberately required by the underlying handshake;
 * the HTML adapter never infers trust from referrer data or accepts `*`.
 */
export async function connectSandboxHtmlSdk<
  const TPlugins extends SandboxHtmlPlugins = SandboxHtmlPlugins,
>(
  options: SandboxHtmlSdkOptions<TPlugins>,
): Promise<SandboxHtmlSdk<TPlugins>> {
  const { window: gameWindow, plugins, ...bridgeOptions } = options;
  const bridge = await acceptSandboxBridge({
    ...bridgeOptions,
    window: gameWindow ?? resolveBrowserWindow(),
  });
  const sdk = createSandboxSdk(bridge, plugins ?? ({} as TPlugins));

  return {
    bridge,
    sdk,
    call: (method, payload, callOptions) => bridge.call(method, payload, callOptions),
    on: (name, handler) => bridge.on(name, handler),
    close: (reason) => bridge.close(reason),
  };
}

/** Alias for callers that prefer a shorter game-oriented name. */
export const connectSandboxGame = connectSandboxHtmlSdk;

export { acceptSandboxBridge } from "./client.js";
export { createSandboxSdk } from "./sdk.js";

function resolveBrowserWindow(): GameWindowLike {
  const gameWindow = globalThis.window;
  if (!gameWindow) {
    throw new TypeError(
      "connectSandboxHtmlSdk requires a browser window or an explicit window option",
    );
  }
  return gameWindow;
}
