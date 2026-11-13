export const SANDBOX_RUNTIME_VERSION = "0.3.2" as const;

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

/** Internal, pure metadata validation shared by host preparation and child admission. */
export function validatePackageManifest(value: unknown): {
  readonly manifest: SandboxPackageManifest;
  readonly paths: readonly string[];
  readonly totalBytes: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return packageError("INVALID_MANIFEST", "Expected formatVersion 1 and root index.html");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== 1 || candidate.entrypoint !== "index.html") {
    return packageError("INVALID_MANIFEST", "Expected formatVersion 1 and root index.html");
  }
  if (!candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files)) {
    return packageError("INVALID_MANIFEST", "Package files must be a manifest record");
  }
  const entries = Object.entries(candidate.files);
  if (!entries.length || entries.length > SANDBOX_PACKAGE_LIMITS.files || !Object.hasOwn(candidate.files, "index.html")) {
    return packageError("INVALID_MANIFEST", "Package must contain root index.html within the file count limit");
  }
  const files: Record<string, { readonly sha256: string; readonly size: number }> = Object.create(null);
  let totalBytes = 0;
  for (const [path, value] of entries) {
    assertPackagePath(path);
    resourceMime(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) packageError("INVALID_MANIFEST", `Invalid size or SHA-256: ${path}`);
    const metadata = value as Record<string, unknown>;
    const size = metadata.size, sha256 = metadata.sha256;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > SANDBOX_PACKAGE_LIMITS.fileBytes ||
        typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      packageError("INVALID_MANIFEST", `Invalid size or SHA-256: ${path}`);
    }
    totalBytes += size;
    if (totalBytes > SANDBOX_PACKAGE_LIMITS.totalBytes) packageError("PACKAGE_TOO_LARGE", "Package byte budget exceeded");
    files[path] = Object.freeze({ sha256, size });
  }
  const manifest = Object.freeze({ formatVersion: 1 as const, entrypoint: "index.html" as const, files: Object.freeze(files) });
  return { manifest, paths: Object.freeze(Object.keys(files)), totalBytes };
}

/** Virtual URL resolution only; never uses the host origin or a network API. */
export function resolvePackageReference(reference: string, from: string): { path: string; suffix: string } {
  if (typeof reference !== "string" || !reference || reference.trim() !== reference ||
      /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//") ||
      /[\\\u0000-\u0020\u007f]/u.test(reference)) {
    return packageError("EXTERNAL_URL", `Only package-relative URLs are supported: ${reference}`);
  }
  assertPackagePath(from);
  // Validate each once-decoded segment BEFORE WHATWG URL can remove encoded
  // dot steps or silently clamp an over-root traversal. Never decode a whole
  // path first: encoded separators must not become structural separators.
  const referencePath = reference.split(/[?#]/, 1)[0]!;
  const rooted = referencePath.startsWith("/");
  let depth = rooted ? 0 : from.split("/").length - 1;
  for (const [index, encoded] of referencePath.split("/").entries()) {
    let part: string;
    try { part = decodeURIComponent(encoded); }
    catch { return packageError("INVALID_PATH", `Invalid URL encoding: ${reference}`); }
    if (part.includes("/") || part.includes("\\") || (!part && referencePath && !(rooted && index === 0))) {
      packageError("INVALID_PATH", `Ambiguous URL separator: ${reference}`);
    }
    if (part === "..") {
      if (--depth < 0) packageError("INVALID_PATH", `URL escapes package: ${reference}`);
    } else if (part && part !== ".") {
      // Also rejects leftover '%' (double encoding), controls and other
      // forbidden path characters even if a later '..' would erase them.
      assertPackagePath(part);
      depth++;
    }
  }
  const url = new URL(reference, `https://package.invalid/${from}`);
  let path: string;
  try { path = decodeURIComponent(url.pathname.slice(1)); }
  catch { return packageError("INVALID_PATH", `Invalid URL: ${reference}`); }
  assertPackagePath(path);
  return { path, suffix: url.search + url.hash };
}

export type ResourcePart = string | {
  readonly asset: string;
  /** Dedicated worker graph: imports use Blob URLs instead of document import maps. */
  readonly worker?: boolean;
  /** Virtual search + hash; Blob materialization drops search, not hash. */
  readonly suffix: string;
};
export interface CompiledResource {
  readonly path: string;
  readonly mime: string;
  readonly parts: readonly ResourcePart[] | null;
}
export interface PackagePlan {
  /** Non-HTML Blob assets only; HTML template bytes remain in snapshot.files. */
  readonly resources: readonly CompiledResource[];
  readonly workers: readonly CompiledResource[];
  /** The sole executable document, compiled from root index.html. */
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
  if (!Object.hasOwn(MIME_TYPES, extension)) return packageError("UNSUPPORTED_FORMAT", `Unsupported file extension: ${path}`);
  return MIME_TYPES[extension]!;
}
