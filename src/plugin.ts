import { z } from "zod";
import { isValidMethodName } from "./protocol.js";

export interface SandboxMethodLimits {
  readonly maxPayloadBytes?: number;
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
  readonly limits?: SandboxMethodLimits;
}): SandboxMethodContract<TInput, TOutput> {
  return definition;
}

export function defineSandboxPlugin<const TMethods extends SandboxPluginMethods>(definition: {
  readonly id: string;
  readonly version: string;
  readonly capabilities?: readonly string[];
  readonly methods: TMethods;
}): SandboxPluginContract<TMethods> {
  assertPluginDefinition(definition.id, definition.methods);

  const capabilities = new Set(definition.capabilities ?? []);
  for (const method of Object.values(definition.methods)) {
    if (method.capability) capabilities.add(method.capability);
  }

  return {
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
  methods: SandboxPluginMethods,
): void {
  if (!isValidMethodName(pluginId)) {
    throw new TypeError(`Invalid plugin ID: ${pluginId}`);
  }

  for (const [methodName, method] of Object.entries(methods)) {
    if (!isValidMethodName(methodName)) {
      throw new TypeError(`Invalid plugin method name: ${methodName}`);
    }
    pluginMethodName(pluginId, methodName);
    if (method.capability && !isValidMethodName(method.capability)) {
      throw new TypeError(`Invalid plugin capability: ${method.capability}`);
    }
  }
}
