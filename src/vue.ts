import {
  inject,
  shallowRef,
  type App,
  type InjectionKey,
  type Plugin,
  type ShallowRef,
} from "vue";
import {
  acceptSandboxBridge,
  type AcceptSandboxBridgeOptions,
  type SandboxBridgeClient,
} from "./client.js";
import {
  createSandboxSdk,
  type SandboxCallTransport,
  type SandboxSdk,
} from "./sdk.js";
import type { SandboxPluginContract } from "./plugin.js";

export type SandboxVuePlugins = Record<string, SandboxPluginContract>;

export interface SandboxVuePluginOptions<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
> {
  /** An already accepted bridge, or a promise for one from a config module. */
  readonly bridge?: SandboxBridgeClient | PromiseLike<SandboxBridgeClient>;
  /** Bridge options for projects that want the plugin to perform the handshake. */
  readonly bridgeOptions?: AcceptSandboxBridgeOptions;
  /** A custom transport for tests or non-bridge integrations. */
  readonly transport?: SandboxCallTransport;
  /** An already-created SDK, or a promise for one from a config module. */
  readonly sdk?: SandboxSdk<TPlugins> | PromiseLike<SandboxSdk<TPlugins>>;
  /** Plugin contracts used to create the injected SDK. */
  readonly plugins?: TPlugins;
  /** Name of the optional app.config.globalProperties entry. */
  readonly globalProperty?: string;
}

export interface SandboxVueReady<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
> {
  readonly bridge: SandboxBridgeClient | null;
  readonly sdk: SandboxSdk<TPlugins>;
}

export interface SandboxVueContext<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
> {
  readonly bridge: ShallowRef<SandboxBridgeClient | null>;
  readonly sdk: ShallowRef<SandboxSdk<TPlugins> | null>;
  readonly ready: Promise<SandboxVueReady<TPlugins>>;
}

export type SandboxVuePlugin<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
> = Plugin & {
  readonly context: SandboxVueContext<TPlugins>;
};

export const SANDBOX_CONTEXT_KEY: InjectionKey<SandboxVueContext> = Symbol(
  "sandbox.vue.context",
);
export const SANDBOX_BRIDGE_KEY: InjectionKey<
  ShallowRef<SandboxBridgeClient | null>
> = Symbol("sandbox.vue.bridge");
export const SANDBOX_SDK_KEY: InjectionKey<
  ShallowRef<SandboxSdk<SandboxVuePlugins> | null>
> = Symbol("sandbox.vue.sdk");

/**
 * Keeps a Vue configuration module typed without coupling it to app creation.
 *
 * Example:
 *
 * ```ts
 * export default defineSandboxVueConfig({
 *   bridgeOptions: { window, expectedHostOrigin },
 *   plugins: { echo: echoPlugin },
 * });
 * ```
 */
export function defineSandboxVueConfig<
  const TPlugins extends SandboxVuePlugins,
  const TConfig extends SandboxVuePluginOptions<TPlugins>,
>(config: TConfig): TConfig {
  return config;
}

/**
 * Creates a Vue 3 plugin that provides the bridge and typed SDK to every
 * descendant component. The core package does not require Vue; import this
 * integration from the `/vue` entry point.
 */
export function createSandboxVuePlugin<
  const TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
>(config: SandboxVuePluginOptions<TPlugins>): SandboxVuePlugin<TPlugins> {
  assertConfig(config);

  const bridgePromise = resolveBridge(config);
  const initialBridge = isSandboxBridge(config.bridge) ? config.bridge : null;
  const bridge = shallowRef<SandboxBridgeClient | null>(initialBridge);
  const sdk = shallowRef<SandboxSdk<TPlugins> | null>(
    isSandboxSdk(config.sdk) ? config.sdk : null,
  );

  const ready = (async (): Promise<SandboxVueReady<TPlugins>> => {
    const resolvedBridge = bridgePromise ? await bridgePromise : null;
    const resolvedSdk = config.sdk
      ? await config.sdk
      : createSdk(config, resolvedBridge);

    bridge.value = resolvedBridge;
    sdk.value = resolvedSdk;
    return { bridge: resolvedBridge, sdk: resolvedSdk };
  })();

  const context: SandboxVueContext<TPlugins> = { bridge, sdk, ready };
  const globalProperty = config.globalProperty ?? "$sandbox";

  const plugin: SandboxVuePlugin<TPlugins> = {
    context,
    install(app: App) {
      app.provide(SANDBOX_CONTEXT_KEY, context);
      app.provide(SANDBOX_BRIDGE_KEY, bridge);
      app.provide(SANDBOX_SDK_KEY, sdk);
      app.config.globalProperties[globalProperty] = context;
    },
  };

  return plugin;
}

/** Alias for callers that prefer a verb-first name. */
export const createVueSandboxPlugin = createSandboxVuePlugin;

export function useSandboxContext<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
>(): SandboxVueContext<TPlugins> {
  const context = inject(SANDBOX_CONTEXT_KEY);
  if (!context) {
    throw new Error(
      "Sandbox Vue plugin is not installed. Call app.use(createSandboxVuePlugin(config)) first.",
    );
  }
  return context as SandboxVueContext<TPlugins>;
}

export function useSandboxBridge(): SandboxVueContext["bridge"] {
  return useSandboxContext().bridge;
}

export function useSandboxSdk<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
>(): SandboxVueContext<TPlugins>["sdk"] {
  return useSandboxContext<TPlugins>().sdk;
}

export function useSandboxReady<
  TPlugins extends SandboxVuePlugins = SandboxVuePlugins,
>(): SandboxVueContext<TPlugins>["ready"] {
  return useSandboxContext<TPlugins>().ready;
}

function assertConfig<TPlugins extends SandboxVuePlugins>(
  config: SandboxVuePluginOptions<TPlugins>,
): void {
  const hasBridge = config.bridge !== undefined;
  const hasBridgeOptions = config.bridgeOptions !== undefined;
  const hasTransport = config.transport !== undefined;

  if (hasBridge && hasBridgeOptions) {
    throw new TypeError("Specify bridge or bridgeOptions, not both");
  }
  if (hasBridge && hasTransport) {
    throw new TypeError("Specify bridge or transport, not both");
  }
  if (hasBridgeOptions && hasTransport) {
    throw new TypeError("Specify bridgeOptions or transport, not both");
  }
  if (config.sdk === undefined && !hasBridge && !hasBridgeOptions && !hasTransport) {
    throw new TypeError(
      "Sandbox Vue config requires bridge, bridgeOptions, transport, or sdk",
    );
  }
  if (
    config.globalProperty !== undefined &&
    (!/^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(config.globalProperty) ||
      config.globalProperty === "__proto__" ||
      config.globalProperty === "constructor" ||
      config.globalProperty === "prototype")
  ) {
    throw new TypeError("globalProperty must be a safe JavaScript property name");
  }
}

function resolveBridge<TPlugins extends SandboxVuePlugins>(
  config: SandboxVuePluginOptions<TPlugins>,
): Promise<SandboxBridgeClient> | null {
  if (config.bridge !== undefined) return Promise.resolve(config.bridge);
  if (config.bridgeOptions !== undefined) {
    return Promise.resolve().then(() => acceptSandboxBridge(config.bridgeOptions!));
  }
  return null;
}

function createSdk<TPlugins extends SandboxVuePlugins>(
  config: SandboxVuePluginOptions<TPlugins>,
  bridge: SandboxBridgeClient | null,
): SandboxSdk<TPlugins> {
  const transport = bridge ?? config.transport;
  if (!transport) {
    throw new TypeError("Sandbox Vue config did not resolve a transport");
  }
  return createSandboxSdk(transport, config.plugins ?? ({} as TPlugins));
}

function isSandboxBridge(
  value: SandboxBridgeClient | PromiseLike<SandboxBridgeClient> | undefined,
): value is SandboxBridgeClient {
  return value !== undefined && typeof (value as PromiseLike<unknown>).then !== "function";
}

function isSandboxSdk<TPlugins extends SandboxVuePlugins>(
  value: SandboxSdk<TPlugins> | PromiseLike<SandboxSdk<TPlugins>> | undefined,
): value is SandboxSdk<TPlugins> {
  return value !== undefined && typeof (value as PromiseLike<unknown>).then !== "function";
}
