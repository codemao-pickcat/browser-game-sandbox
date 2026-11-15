import { z } from "zod";
import { defineMethod, defineSandboxPlugin } from "./plugin.js";
import { composeHostPlugins, createHostPlugin, type ComposedHostPlugins } from "./host-plugin.js";

export interface SandboxClipboardAdapter {
  readText(signal: AbortSignal): Promise<string>;
}

const capability = "package.clipboard.read";
const encoder = new TextEncoder();
const maxBytes = 8 * 1024;
const contract = defineSandboxPlugin({
  id: "package.clipboard", version: "1.0.0", capabilities: [capability],
  gameApi: { clipboardReadText: "readText" },
  methods: {
    readText: defineMethod({
      capability,
      input: z.object({}).strict(),
      output: z.string().max(maxBytes).refine(value => encoder.encode(value).byteLength <= maxBytes),
      defaultTimeoutMs: 30_000,
      limits: { maxConcurrent: 1, timeoutMs: 30_000 },
    }),
  },
});

/** Internal. The session supplies an adapter only after an explicit clipboardRead grant. */
export function packageClipboardPlugin(adapter?: SandboxClipboardAdapter): ComposedHostPlugins {
  if (!adapter) return composeHostPlugins([]);
  const readText = adapter.readText.bind(adapter);
  // Retain the slot even if the RPC times out but a non-cooperative adapter
  // hasn't settled. Cancellation cannot create overlapping native reads.
  let reading = false;
  return composeHostPlugins([createHostPlugin(contract, {
    readText: async (_input, { signal }) => {
      signal.throwIfAborted();
      if (reading) throw new Error("Clipboard read still in progress");
      reading = true;
      try {
        const text = await readText(signal);
        signal.throwIfAborted(); // Never return a late result after cancel/stop.
        return text;
      } finally { reading = false; }
    },
  })], { grantedCapabilities: [capability] });
}
