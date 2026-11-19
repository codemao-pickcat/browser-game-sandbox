import { z } from "zod";
import { SandboxBridgeError } from "./errors.js";
import { composeHostPlugins, createHostPlugin, type ComposedHostPlugins } from "./host-plugin.js";
import {
  SANDBOX_CLOUD_PAYLOAD_BYTES,
  SandboxCloudVariablesError,
  cloudApplyRequest,
  cloudApplyResult,
  cloudGetRequest,
  cloudGetResult,
  decodeCloudPayload,
  encodeCloudMessage,
  encodeCloudPayload,
  isCloudErrorCode,
  type SandboxCloudApplyRequest,
  type SandboxCloudApplyResult,
  type SandboxCloudGetRequest,
  type SandboxCloudGetResult,
} from "./package-cloud-variables-wire.js";
import { defineMethod, defineSandboxPlugin } from "./plugin.js";

/** Trusted host adapter bound to one authorized work and player session. */
export interface SandboxCloudVariablesAdapter {
  get(request: SandboxCloudGetRequest, signal: AbortSignal): Promise<SandboxCloudGetResult>;
  apply(request: SandboxCloudApplyRequest, signal: AbortSignal): Promise<SandboxCloudApplyResult>;
}

const capability = "package.cloud-variables";
const wire = z.string().max(SANDBOX_CLOUD_PAYLOAD_BYTES);
const timeoutMs = 15_000;
const limits = { maxPayloadBytes: SANDBOX_CLOUD_PAYLOAD_BYTES, timeoutMs };
const readers = 4;
const writers = 1;
const contract = defineSandboxPlugin({
  id: capability, version: "1.0.0", capabilities: [capability],
  gameApi: { cloudGet: "get", cloudApply: "apply" },
  methods: {
    get: defineMethod({ capability, input: wire, output: wire, defaultTimeoutMs: timeoutMs, limits: { ...limits, maxConcurrent: readers } }),
    apply: defineMethod({ capability, input: wire, output: wire, defaultTimeoutMs: timeoutMs, limits: { ...limits, maxConcurrent: writers } }),
  },
});

function encodeBusinessError(error: SandboxBridgeError): string {
  const resetAt = error instanceof SandboxCloudVariablesError ? error.resetAt : undefined;
  return encodeCloudPayload({ error: { code: error.code, ...(resetAt === undefined ? {} : { resetAt }) } });
}

function bindOperation<TRequest>(
  input: z.ZodType<TRequest>,
  output: z.ZodType,
  maximum: number,
  run: (request: TRequest, signal: AbortSignal) => Promise<unknown>,
): (payload: string, context: { signal: AbortSignal }) => Promise<string> {
  let active = 0;
  return async (payload, { signal }) => {
    let request: TRequest;
    try {
      request = decodeCloudPayload(payload, input);
    } catch {
      return encodeBusinessError(new SandboxCloudVariablesError("INVALID_ARGUMENT"));
    }
    // Keep a slot until the adapter settles even if the RPC times out first.
    if (active >= maximum) return encodeBusinessError(new SandboxCloudVariablesError("RATE_LIMITED"));
    signal.throwIfAborted();
    active++;
    let result: unknown;
    try {
      result = await run(request, signal);
    } catch (error) {
      if (signal.aborted) return "";
      if (error instanceof SandboxBridgeError && isCloudErrorCode(error.code)) return encodeBusinessError(error);
      throw error;
    } finally {
      active--;
    }
    // The bridge discards aborted responses before sending. Skip their encoding as well.
    return signal.aborted ? "" : encodeCloudMessage(result, output);
  };
}

/** Internal. A session supplies this adapter only after an explicit grant. */
export function packageCloudVariablesPlugin(adapter?: SandboxCloudVariablesAdapter): ComposedHostPlugins {
  if (!adapter) return composeHostPlugins([]);
  const plugin = createHostPlugin(contract, {
    get: bindOperation(cloudGetRequest, cloudGetResult, readers, adapter.get.bind(adapter)),
    apply: bindOperation(cloudApplyRequest, cloudApplyResult, writers, adapter.apply.bind(adapter)),
  });
  return composeHostPlugins([plugin], { grantedCapabilities: [capability] });
}
