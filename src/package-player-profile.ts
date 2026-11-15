import { z } from "zod";
import { composeHostPlugins, createHostPlugin } from "./host-plugin.js";
import { defineMethod, defineSandboxPlugin } from "./plugin.js";

export const SANDBOX_PLAYER_AVATAR_MAX_BYTES = 48 * 1024;
export const SANDBOX_PLAYER_AVATAR_TYPES: readonly string[] = Object.freeze([
  "image/webp", "image/png", "image/jpeg", "image/gif",
]);

export interface SandboxPlayerProfile {
  readonly playerId: string;
  readonly displayName: string | null;
  readonly avatar: Blob | null;
}

const capability = "package.player-profile.read";
const contract = defineSandboxPlugin({
  id: "package.player-profile",
  version: "1.0.0",
  capabilities: [capability],
  gameApi: { getPlayerProfile: "read" },
  methods: {
    read: defineMethod({
      capability,
      input: z.object({}).strict(),
      output: z.object({
        playerId: z.string().min(1).max(128),
        displayName: z.string().min(1).max(200).nullable(),
        avatar: z.custom<Blob>(value =>
          typeof Blob !== "undefined" &&
          value instanceof Blob &&
          value.size > 0 &&
          value.size <= SANDBOX_PLAYER_AVATAR_MAX_BYTES &&
          SANDBOX_PLAYER_AVATAR_TYPES.includes(value.type),
        ).nullable(),
      }).strict(),
      defaultTimeoutMs: 5_000,
      limits: { maxConcurrent: 1 },
    }),
  },
});

export function packagePlayerProfilePlugin(profile?: SandboxPlayerProfile) {
  if (!profile) return composeHostPlugins([]);
  const snapshot = contract.methods.read.output.parse(profile);
  return composeHostPlugins([
    createHostPlugin(contract, { read: () => snapshot }),
  ], { grantedCapabilities: [capability] });
}
