import { rm } from "node:fs/promises";

// tsc does not remove outputs for deleted sources. Never republish retired SDKs
// merely because dist was populated by a previous version's build.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
