import { assertValidOrigin } from "./protocol.js";

export interface SandboxGamePackageManifest {
  /** The only document that may be used as the package entry point. */
  readonly entry: "index.html";
  /** Exact package-relative resources served to the game origin. */
  readonly resources: readonly string[];
}

export interface SandboxGamePackagePolicy {
  readonly entryPath: "/index.html";
  readonly resources: readonly string[];
  isAllowedResourcePath(path: string): boolean;
  assertEntryPath(path: string): "/index.html";
  assertAllowedResourcePath(path: string): string;
  assertAllowedResourceUrl(url: string, gameOrigin: string): string;
}

/**
 * Creates the resource policy that a game package server should apply to
 * every request. The browser CSP still belongs on every HTML response; this
 * policy closes the separate gap where a same-origin navigation reaches an
 * undeclared HTML document without that CSP.
 */
export function createSandboxGamePackagePolicy(
  manifest: SandboxGamePackageManifest,
): SandboxGamePackagePolicy {
  if (manifest.entry !== "index.html") {
    throw new TypeError("Sandbox game package entry must be index.html");
  }

  const resources = new Set<string>();
  for (const resource of manifest.resources) {
    const normalized = normalizeResourcePath(resource);
    if (resources.has(normalized)) {
      throw new TypeError(`Duplicate sandbox package resource: ${normalized}`);
    }
    resources.add(normalized);
  }

  if (!resources.has("/index.html")) {
    throw new TypeError("Sandbox game package resources must include /index.html");
  }

  const frozenResources = Object.freeze([...resources]);
  return {
    entryPath: "/index.html",
    resources: frozenResources,
    isAllowedResourcePath(path) {
      try {
        return resources.has(normalizeResourcePath(path));
      } catch {
        return false;
      }
    },
    assertEntryPath(path) {
      const normalized = normalizeResourcePath(path);
      if (normalized !== "/index.html") {
        throw new TypeError(`Sandbox game entry must be /index.html, received: ${normalized}`);
      }
      return "/index.html";
    },
    assertAllowedResourcePath(path) {
      const normalized = normalizeResourcePath(path);
      if (!resources.has(normalized)) {
        throw new TypeError(`Sandbox package resource is not whitelisted: ${normalized}`);
      }
      return normalized;
    },
    assertAllowedResourceUrl(url, gameOrigin) {
      assertValidOrigin(gameOrigin);
      let parsed: URL;
      try {
        parsed = new URL(url, gameOrigin);
      } catch {
        throw new TypeError(`Invalid sandbox package URL: ${url}`);
      }
      if (parsed.origin !== gameOrigin || parsed.search || parsed.hash) {
        throw new TypeError(`Sandbox package URL must use the game origin without query or hash: ${url}`);
      }
      return this.assertAllowedResourcePath(parsed.pathname);
    },
  };
}

function normalizeResourcePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Sandbox package resource path must be a non-empty string");
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new TypeError("Sandbox package resource path contains a control character");
  }

  const pathWithoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
  if (
    pathWithoutLeadingSlash.length === 0 ||
    pathWithoutLeadingSlash.includes("\\") ||
    pathWithoutLeadingSlash.includes("?") ||
    pathWithoutLeadingSlash.includes("#") ||
    pathWithoutLeadingSlash.startsWith("/")
  ) {
    throw new TypeError(`Invalid sandbox package resource path: ${path}`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathWithoutLeadingSlash);
  } catch {
    throw new TypeError(`Invalid encoded sandbox package resource path: ${path}`);
  }
  if (decoded !== pathWithoutLeadingSlash || decoded.includes("\\")) {
    throw new TypeError(`Encoded or ambiguous sandbox package resource path: ${path}`);
  }

  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`Traversal or empty segment in sandbox package resource path: ${path}`);
  }
  return `/${decoded}`;
}
