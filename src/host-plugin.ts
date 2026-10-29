import {
  pluginMethodName,
  type MethodInput,
  type MethodOutput,
  type SandboxPluginContract,
} from "./plugin.js";
import type {
  HostMethodContext,
  HostMethodDefinition,
} from "./host.js";

export interface PluginHandlerContext {
  readonly pluginId: string;
  readonly methodName: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type HostPluginHandlers<TPlugin extends SandboxPluginContract> = {
  [TMethodName in keyof TPlugin["methods"]]: (
    input: MethodInput<TPlugin["methods"][TMethodName]>,
    context: PluginHandlerContext,
  ) => MethodOutput<TPlugin["methods"][TMethodName]> | Promise<MethodOutput<TPlugin["methods"][TMethodName]>>;
};

export interface HostPlugin<TPlugin extends SandboxPluginContract> {
  readonly contract: TPlugin;
  readonly handlers: HostPluginHandlers<TPlugin>;
}

export interface ComposedHostPlugins {
  readonly capabilities: readonly string[];
  readonly methods: Readonly<Record<string, HostMethodDefinition>>;
}

export function createHostPlugin<TPlugin extends SandboxPluginContract>(
  contract: TPlugin,
  handlers: HostPluginHandlers<TPlugin>,
): HostPlugin<TPlugin> {
  return { contract, handlers };
}

export function composeHostPlugins(
  plugins: readonly HostPlugin<SandboxPluginContract>[],
): ComposedHostPlugins {
  const capabilities = new Set<string>();
  const methods: Record<string, HostMethodDefinition> = {};
  const pluginIds = new Set<string>();

  for (const plugin of plugins) {
    const { contract, handlers } = plugin;
    if (pluginIds.has(contract.id)) {
      throw new TypeError(`Duplicate plugin ID: ${contract.id}`);
    }
    pluginIds.add(contract.id);

    for (const capability of contract.capabilities) capabilities.add(capability);

    for (const [methodName, method] of Object.entries(contract.methods)) {
      const fullName = pluginMethodName(contract.id, methodName);
      if (methods[fullName]) {
        throw new TypeError(`Duplicate plugin method: ${fullName}`);
      }
      if (method.capability) capabilities.add(method.capability);

      const handler = handlers[methodName];
      if (!handler) {
        throw new TypeError(`Missing handler for plugin method: ${fullName}`);
      }

      const hostMethod: HostMethodDefinition = {
        ...(method.capability !== undefined ? { capability: method.capability } : {}),
        ...(method.limits ?? {}),
        validate(payload) {
          const result = method.input.safeParse(payload);
          if (!result.success) throw new TypeError("Invalid plugin input");
        },
        async handler(payload, context: HostMethodContext) {
          const parsedInput = method.input.parse(payload) as MethodInput<typeof method>;
          const output = await handler(parsedInput, {
            pluginId: contract.id,
            methodName: fullName,
            requestId: context.requestId,
            signal: context.signal,
          });
          return method.output.parse(output) as MethodOutput<typeof method>;
        },
      };
      methods[fullName] = hostMethod;
    }
  }

  return { capabilities: [...capabilities], methods };
}
