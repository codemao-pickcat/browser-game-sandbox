import { z } from "zod";
import { SandboxBridgeError } from "./errors.js";
import type { BridgeCallOptions } from "./client.js";
import {
  pluginMethodName,
  type MethodInput,
  type MethodOutput,
  type SandboxMethodContract,
  type SandboxPluginContract,
} from "./plugin.js";

export interface SandboxCallTransport {
  call<T>(method: string, payload: unknown, options?: BridgeCallOptions): Promise<T>;
}

export class SandboxSdkValidationError extends SandboxBridgeError {
  public readonly direction: "input" | "output";
  public readonly pluginId: string;
  public readonly methodName: string;
  public readonly issues: readonly unknown[];

  public constructor(
    direction: "input" | "output",
    pluginId: string,
    methodName: string,
    error: z.ZodError,
  ) {
    super(
      "INVALID_PAYLOAD",
      `Invalid ${direction} for ${pluginMethodName(pluginId, methodName)}`,
    );
    this.name = "SandboxSdkValidationError";
    this.direction = direction;
    this.pluginId = pluginId;
    this.methodName = methodName;
    this.issues = error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: [...issue.path],
    }));
  }
}

export type SandboxPluginSdk<TPlugin extends SandboxPluginContract> = {
  [TMethodName in keyof TPlugin["methods"]]: (
    input: MethodInput<TPlugin["methods"][TMethodName]>,
    options?: BridgeCallOptions,
  ) => Promise<MethodOutput<TPlugin["methods"][TMethodName]>>;
};

export type SandboxSdk<
  TPlugins extends Record<string, SandboxPluginContract>,
> = {
  [TPluginAlias in keyof TPlugins]: SandboxPluginSdk<TPlugins[TPluginAlias]>;
};

export function createSandboxSdk<
  const TPlugins extends Record<string, SandboxPluginContract>,
>(transport: SandboxCallTransport, plugins: TPlugins): SandboxSdk<TPlugins> {
  const sdk: Record<string, unknown> = Object.create(null);

  for (const [alias, plugin] of Object.entries(plugins)) {
    if (Object.prototype.hasOwnProperty.call(sdk, alias)) {
      throw new TypeError(`Duplicate plugin alias: ${alias}`);
    }
    if (alias === "then") {
      throw new TypeError("Plugin alias cannot be then");
    }
    sdk[alias] = createPluginSdk(transport, plugin);
  }

  return sdk as SandboxSdk<TPlugins>;
}

export function createPluginSdk<TPlugin extends SandboxPluginContract>(
  transport: SandboxCallTransport,
  plugin: TPlugin,
): SandboxPluginSdk<TPlugin> {
  const sdk: Record<string, unknown> = Object.create(null);

  for (const [methodName, method] of Object.entries(plugin.methods)) {
    if (Object.prototype.hasOwnProperty.call(sdk, methodName)) {
      throw new TypeError(`Duplicate plugin method: ${methodName}`);
    }
    if (methodName === "then") {
      throw new TypeError("Plugin method cannot be then");
    }
    sdk[methodName] = async (
      input: unknown,
      options?: BridgeCallOptions,
    ): Promise<unknown> => {
      const parsedInput = method.input.safeParse(input);
      if (!parsedInput.success) {
        throw new SandboxSdkValidationError(
          "input",
          plugin.id,
          methodName,
          parsedInput.error,
        );
      }

      const rawOutput = await transport.call<unknown>(
        pluginMethodName(plugin.id, methodName),
        parsedInput.data,
        options,
      );
      const parsedOutput = method.output.safeParse(rawOutput);
      if (!parsedOutput.success) {
        throw new SandboxSdkValidationError(
          "output",
          plugin.id,
          methodName,
          parsedOutput.error,
        );
      }
      return parsedOutput.data;
    };
  }

  return sdk as SandboxPluginSdk<TPlugin>;
}
