import { z } from "zod";
import { DEFAULT_CALL_TIMEOUT_MS, isValidMethodName } from "./protocol.js";
import { assertGameApiName } from "./game-api-config.js";

export interface SandboxMethodLimits {
  readonly maxPayloadBytes?: number;
  /** Independent host execution limit; callers cannot extend it. */
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

export interface SandboxMethodContract<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly capability?: string;
  readonly input: TInput;
  readonly output: TOutput;
  /** End-to-end call timeout, including handshake waiting; defaults to 5000ms. */
  readonly defaultTimeoutMs?: number | undefined;
  readonly limits?: SandboxMethodLimits;
}

export type SandboxPluginMethods = Record<string, SandboxMethodContract>;

export interface SandboxPluginContract<
  TMethods extends SandboxPluginMethods = SandboxPluginMethods,
> {
  readonly id: string;
  readonly version: string;
  readonly bridgeProtocol: 1;
  readonly capabilities: readonly string[];
  readonly methods: TMethods;
  /** Explicit flat window.game aliases -> method names from this plugin. */
  readonly gameApi?: Readonly<Record<string, keyof TMethods & string>>;
}

export type MethodInput<
  TMethod extends SandboxMethodContract,
> = z.input<TMethod["input"]>;

export type MethodOutput<
  TMethod extends SandboxMethodContract,
> = z.output<TMethod["output"]>;

export function defineMethod<
  const TInput extends z.ZodType,
  const TOutput extends z.ZodType,
>(definition: {
  readonly capability?: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly defaultTimeoutMs?: number | undefined;
  readonly limits?: SandboxMethodLimits;
}): SandboxMethodContract<TInput, TOutput> & { readonly defaultTimeoutMs: number } {
  const defaultTimeoutMs = definition.defaultTimeoutMs === undefined
    ? DEFAULT_CALL_TIMEOUT_MS
    : definition.defaultTimeoutMs;
  assertDefaultTimeoutMs(defaultTimeoutMs);
  return { ...definition, defaultTimeoutMs };
}

function assertDefaultTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("defaultTimeoutMs must be a finite positive number");
  }
}

export function defineSandboxPlugin<const TMethods extends SandboxPluginMethods>(definition: {
  readonly id: string;
  readonly version: string;
  readonly capabilities?: readonly string[];
  readonly methods: TMethods;
  readonly gameApi?: Readonly<Record<string, keyof TMethods & string>>;
}): SandboxPluginContract<TMethods> {
  assertPluginDefinition(
    definition.id,
    definition.version,
    definition.capabilities ?? [],
    definition.methods,
  );

  const capabilities = new Set(definition.capabilities ?? []);
  for (const method of Object.values(definition.methods)) {
    if (method.capability) capabilities.add(method.capability);
  }

  for (const [name, method] of Object.entries(definition.gameApi ?? {})) {
    assertGameApiName(name);
    if (!Object.prototype.hasOwnProperty.call(definition.methods, method)) {
      throw new TypeError(`Unknown game API method: ${method}`);
    }
  }

  return {
    ...(definition.gameApi !== undefined ? { gameApi: Object.freeze({ ...definition.gameApi }) } : {}),
    id: definition.id,
    version: definition.version,
    bridgeProtocol: 1,
    capabilities: [...capabilities],
    methods: definition.methods,
  };
}

export function pluginMethodName(pluginId: string, methodName: string): string {
  const fullName = `${pluginId}.${methodName}`;
  if (!isValidMethodName(fullName)) {
    throw new TypeError(`Invalid plugin method name: ${fullName}`);
  }
  return fullName;
}

function assertPluginDefinition(
  pluginId: string,
  version: string,
  capabilities: readonly string[],
  methods: SandboxPluginMethods,
): void {
  if (!isValidMethodName(pluginId)) {
    throw new TypeError(`Invalid plugin ID: ${pluginId}`);
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError(`Invalid plugin version: ${version}`);
  }

  for (const capability of capabilities) {
    if (!isValidMethodName(capability)) {
      throw new TypeError(`Invalid plugin capability: ${capability}`);
    }
  }

  for (const [methodName, method] of Object.entries(methods)) {
    if (!isValidMethodName(methodName)) {
      throw new TypeError(`Invalid plugin method name: ${methodName}`);
    }
    pluginMethodName(pluginId, methodName);
    if (method.defaultTimeoutMs !== undefined) assertDefaultTimeoutMs(method.defaultTimeoutMs);
    if (method.capability && !isValidMethodName(method.capability)) {
      throw new TypeError(`Invalid plugin capability: ${method.capability}`);
    }
  }
}
