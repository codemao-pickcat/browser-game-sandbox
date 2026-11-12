export const SANDBOX_RUNTIME_VERSION = "0.3.0" as const;

export interface SandboxPackageManifest {
  readonly formatVersion: 1;
  readonly entrypoint: "index.html";
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly size: number }>>;
}
export interface SandboxPackageInput {
  readonly manifest: SandboxPackageManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
}

// Independent of the RPC budget. Bounds both preparation and each transfer.
export const SANDBOX_PACKAGE_LIMITS = Object.freeze({
  files: 2000,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  textBytes: 25 * 1024 * 1024,
  compiledBytes: 100 * 1024 * 1024,
  pathBytes: 512,
  transferChunkBytes: 256 * 1024,
  transferTimeoutMs: 30_000,
});

export class SandboxPackageError extends TypeError {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SandboxPackageError";
  }
}
export function packageError(code: string, message: string): never {
  throw new SandboxPackageError(code, message);
}

export function assertPackagePath(path: string): void {
  if (typeof path !== "string" || !path || new TextEncoder().encode(path).byteLength > SANDBOX_PACKAGE_LIMITS.pathBytes ||
      /[\\:%?#\u0000-\u0020\u007f]/u.test(path) || path.startsWith("/") ||
      path.split("/").some(part => !part || part === "." || part === "..")) {
    packageError("INVALID_PATH", `Invalid package path: ${String(path).slice(0, 512)}`);
  }
}

/** Virtual URL resolution only; never uses the host origin or a network API. */
export function resolvePackageReference(reference: string, from: string): { path: string; suffix: string } {
  if (typeof reference !== "string" || !reference || reference.trim() !== reference ||
      /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//") ||
      /[\\\u0000-\u0020\u007f]/u.test(reference)) {
    return packageError("EXTERNAL_URL", `Only package-relative URLs are supported: ${reference}`);
  }
  const url = new URL(reference, `https://package.invalid/${from}`);
  let path: string;
  try { path = decodeURIComponent(url.pathname.slice(1)); }
  catch { return packageError("INVALID_PATH", `Invalid URL: ${reference}`); }
  assertPackagePath(path);
  // Reject traversal beyond the virtual root instead of URL's silent clamp.
  let depth = reference.startsWith("/") ? 0 : from.split("/").length - 1;
  for (const part of reference.split(/[?#]/, 1)[0]!.split("/")) {
    if (part === "..") { if (--depth < 0) packageError("INVALID_PATH", `URL escapes package: ${reference}`); }
    else if (part && part !== ".") depth++;
  }
  return { path, suffix: url.search + url.hash };
}

export type ResourcePart = string | { readonly asset: string; readonly suffix: string };
export interface CompiledResource {
  readonly path: string;
  readonly mime: string;
  readonly parts: readonly ResourcePart[] | null;
}
export interface PackagePlan {
  readonly resources: readonly CompiledResource[];
  readonly html: readonly ResourcePart[];
}
export interface PackageSnapshot {
  readonly manifest: SandboxPackageManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly totalBytes: number;
  readonly plan: PackagePlan;
}

export function moduleSpecifier(path: string): string {
  return `sandbox-package:/${path}`;
}

export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", txt: "text/plain", csv: "text/csv", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", bin: "application/octet-stream",
});
export function resourceMime(path: string): string {
  const extension = path.split(".").pop()!.toLowerCase();
  return MIME_TYPES[extension] ?? packageError("UNSUPPORTED_FORMAT", `Unsupported file extension: ${path}`);
}
