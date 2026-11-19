/** Optional work capabilities. Authorization/consent belongs to the trusted player. */
export type SandboxPackagePermission = "worker" | "wasm" | "pointerLock" | "eval" | "clipboardRead" | "playerProfile" | "cloudVariables";

/** Canonical persistence/display order. Never infer grants from package contents. */
export const SANDBOX_PACKAGE_PERMISSIONS = Object.freeze([
  "worker", "wasm", "pointerLock", "eval", "clipboardRead", "playerProfile", "cloudVariables",
] as const satisfies readonly SandboxPackagePermission[]);

/** Validate untrusted metadata, deduplicate and expand eval's unavoidable WASM grant. */
export function normalizeSandboxPackagePermissions(input: unknown): SandboxPackagePermission[] {
  if (!Array.isArray(input)) throw new TypeError("Sandbox package permissions must be an array");
  const granted = new Set<SandboxPackagePermission>();
  for (const value of input) {
    if (typeof value !== "string" || !(SANDBOX_PACKAGE_PERMISSIONS as readonly string[]).includes(value)) {
      throw new TypeError("Unknown sandbox package permission");
    }
    granted.add(value as SandboxPackagePermission);
  }
  // CSP unsafe-eval enables WebAssembly too; never present eval-only as a choice.
  if (granted.has("eval")) granted.add("wasm");
  return SANDBOX_PACKAGE_PERMISSIONS.filter(permission => granted.has(permission));
}
