export const NPM_PACKAGE_DIRECTORY = "__moss_npm__";

export function isNpmPackagePath(path: string): boolean {
  return path === NPM_PACKAGE_DIRECTORY || path.startsWith(`${NPM_PACKAGE_DIRECTORY}/`);
}

export function npmPackagePath(sha256: string): string {
  return `${NPM_PACKAGE_DIRECTORY}/${sha256}.mjs`;
}

export function isNpmPackageName(name: string): boolean {
  return name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?![\s\S])/.test(name);
}

export function isExactNpmVersion(version: string): boolean {
  const match = version.length <= 128 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  return !!match && match[0] === version && !match[1]?.split(".").some(part => /^0[0-9]+$/.test(part));
}

export function parseNpmSpecifier(specifier: string): { name: string; version: string } | undefined {
  if (!specifier.startsWith("npm:")) return;
  const separator = specifier.lastIndexOf("@");
  if (separator <= 4) return;
  const name = specifier.slice(4, separator);
  const version = specifier.slice(separator + 1);
  if (isNpmPackageName(name) && (version === "latest" || isExactNpmVersion(version))) return { name, version };
}
