import { parse as parseHtml, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import * as css from "css-tree";
import { parse as parseJs, type Node } from "acorn";
import { simple } from "acorn-walk";
import { isNpmPackagePath, parseNpmSpecifier } from "./package-npm.js";
import {
  SANDBOX_PACKAGE_LIMITS as LIMITS, SANDBOX_RUNTIME_VERSION,
  moduleSpecifier, packageError, parseInlineDataUrl, resolvePackageReference, knownResourceMime, validatePackageManifest,
  type CompiledResource, type PackagePlan, type PackageSnapshot, type ResourcePart,
  type SandboxPackageInput, type SandboxPackageManifest,
} from "./package-format.js";
export {
  SANDBOX_PACKAGE_LIMITS, SANDBOX_RUNTIME_VERSION, SandboxPackageError,
  type SandboxPackageInput, type SandboxPackageManifest,
} from "./package-format.js";

const preparedBrand: unique symbol = Symbol("PreparedSandboxPackage");
/** Opaque, immutable preparation handle. Prepare again after transport between realms. */
export interface PreparedSandboxPackage {
  readonly runtimeVersion: typeof SANDBOX_RUNTIME_VERSION;
  readonly totalBytes: number;
  readonly manifest: SandboxPackageManifest;
  readonly [preparedBrand]: true;
}
const snapshots = new WeakMap<PreparedSandboxPackage, PackageSnapshot>();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MARKER = "__SANDBOX_PACKAGE_ASSET_";
// A `rel` is a space-separated, case-insensitive token list. Hint-only tags are
// scrubbed from the document outright: they cannot warm anything offline, since
// every Blob URL already exists before user scripts run. `manifest` is inert for
// same reason: the reference document is never fetched or installed. Favicons
// likewise have no visible effect inside the iframe.
const INERT_LINK_RELATIONS: ReadonlySet<string> = new Set(["preload", "prefetch", "modulepreload", "preconnect", "dns-prefetch", "manifest", "icon"]);
// Attributes that carry URLs or documents no offline document can ever use: an
// integrity check against a rewritten Blob, a beacon, a cached manifest, plugin
// code base, archive fallback, or a nested document source. Dropping them keeps
// uploader markup working instead of forcing manual edits.
const INERT_ATTRIBUTES: ReadonlySet<string> = new Set(["integrity", "ping", "manifest", "codebase", "archive", "srcdoc"]);
const UNSUPPORTED_ELEMENTS: ReadonlySet<string> = new Set(["base", "iframe", "frame", "frameset", "object", "embed", "applet", "portal"]);
// Navigation that runs code or spawns a data document stays rejected. Ordinary
// links are inert: the runtime loader cancels every a/area click in the capture
// phase and only honours `#fragment`, so those values never reach the network.
// URL parsing strips C0 controls and spaces around the value and every ASCII
// tab/newline before the scheme is read, so the check has to do the same.
const ACTIVE_HREF_SCHEMES = /^(?:javascript|data|vbscript):/;
const activeHrefScheme = (value: string): boolean => ACTIVE_HREF_SCHEMES.test(value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "").toLowerCase());
type HtmlNode = DefaultTreeAdapterMap["node"];
type JsNode = Node & { name?: string; value?: unknown; source?: unknown; options?: unknown; attributes?: unknown; arguments?: unknown; callee?: unknown; object?: unknown; property?: unknown; meta?: unknown; computed?: boolean; expressions?: readonly Node[]; quasis?: readonly { value: { cooked: string | null } }[] };
type Edit = { start: number; end: number; text: string };
// Rewritten literals can contain chars that were escaped in the input. Keep
// '<' escaped so raw text in an inline script cannot become an HTML end tag.
const quoteJs = (value: string): string => JSON.stringify(value).replaceAll("<", "\\u003c");
const CSS_IMAGE_SET_FUNCTIONS = new Set(["image-set", "-webkit-image-set"]);
const cssName = (name: string | undefined): string => name === undefined ? "" : css.ident.decode(name).toLowerCase();
const SVG_URL_PROPERTIES = new Set(["fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"]);

/** No evaluation, DOM, fetch, or other network I/O. Identical validator in Node/browser. */
export async function prepareSandboxPackage(input: SandboxPackageInput): Promise<PreparedSandboxPackage> {
  const verified = await verifyPackageBytes(input);
  return adoptPreparedSnapshot({ ...verified, plan: compileVerifiedPackage(verified) });
}

/** Snapshot and verify using native asynchronous crypto before handing bytes to our compiler worker. */
export async function verifyPackageBytes(input: SandboxPackageInput): Promise<Omit<PackageSnapshot, "plan">> {
  if (!input || typeof input !== "object" || !input.files || typeof input.files !== "object" || Array.isArray(input.files)) {
    return packageError("INVALID_MANIFEST", "Package files must be a byte record");
  }
  const { manifest, paths, totalBytes } = validatePackageManifest(input.manifest);
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const path of paths) {
    const metadata = manifest.files[path]!;
    const bytes = Object.hasOwn(input.files, path) ? input.files[path] : undefined;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== metadata.size) {
      packageError("INTEGRITY", `Byte length mismatch: ${path}`);
    }
    // Snapshot before awaiting: caller mutation cannot change the verified package.
    files[path] = new Uint8Array(bytes!);
  }
  if (Object.keys(input.files).length !== paths.length) packageError("INTEGRITY", "Unexpected files outside manifest");
  for (const [path, bytes] of Object.entries(files)) {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== manifest.files[path]!.sha256) packageError("INTEGRITY", `SHA-256 mismatch: ${path}`);
  }
  return { manifest, files, totalBytes };
}

/** Internal: never exported by the public entry. Returns fresh transfer-owned bytes. */
export function snapshotPreparedPackage(prepared: PreparedSandboxPackage): PackageSnapshot {
  const snapshot = snapshots.get(prepared);
  if (!snapshot) return packageError("NOT_PREPARED", "Package must come from prepareSandboxPackage in this realm");
  return { ...snapshot, files: Object.fromEntries(Object.entries(snapshot.files).map(([path, bytes]) => [path, new Uint8Array(bytes)])) };
}

export function compileVerifiedPackage({ manifest, files }: Omit<PackageSnapshot, "plan">): PackagePlan {
  return compilePackage(files, manifest.formatVersion === 2 ? manifest.moduleAliases : undefined);
}

/** Reuses the compiler's source traversal, without acquiring or executing modules. */
export function collectSandboxNpmImports(files: SandboxPackageInput["files"]): readonly string[] {
  const specifiers = new Set<string>();
  compilePackage(files, undefined, specifiers);
  return [...specifiers];
}

export function compilePackage(files: Readonly<Record<string, Uint8Array>>, aliases?: Readonly<Record<string, string>>, specifiers?: Set<string>): PackagePlan {
  const markers: { asset: string; suffix: string; worker?: boolean }[] = [];
  const workerPaths = new Set<string>();
  const classicPaths = new Set<string>();
  // Legacy scripts removed with their nomodule tag keep their bytes as inert
  // fetch-only data: nothing can load them, so their syntax must not fail prepare.
  const droppedScriptPaths = new Set<string>();
  // Every package path some live tag or expression still resolves to, including
  // module specifiers, which never receive a Blob marker.
  const referencedPaths = new Set<string>();
  const reference = (value: string, from: string, kind: "asset" | "script" | "module" | "css" | "fetch" | "worker" = "asset"): string => {
    if (value.startsWith("#") && kind === "asset") return value;
    if (parseInlineDataUrl(value) !== undefined) {
      if (kind !== "asset") return packageError("INLINE_RESOURCE", `Inline data: ${kind} references must use a separate package file: ${from}`);
      if (value.includes(MARKER)) return packageError("RESERVED_TEXT", `Reserved runtime marker in decoded asset reference: ${from}`);
      return value;
    }
    const resolved = resolvePackageReference(value, from);
    if (aliases && isNpmPackagePath(resolved.path)) return packageError("UNSUPPORTED_MODULE", "Use npm imports to access cached modules");
    referencedPaths.add(resolved.path);
    if (!Object.hasOwn(files, resolved.path)) return packageError("MISSING_RESOURCE", `${from} references missing file: ${value}`);
    const mime = knownResourceMime(resolved.path);
    if (mime === undefined && kind !== "fetch") packageError("UNSUPPORTED_REFERENCE", `Fallback data supports package GET/HEAD only, not ${kind} references: ${value}`);
    if (mime === "text/html" && kind !== "fetch") packageError("UNSUPPORTED_REFERENCE", "HTML is passive fetch data only; HTML assets, subdocuments and navigation are unsupported");
    if ((kind === "module" || kind === "script" || kind === "worker") && mime !== "text/javascript") packageError("UNSUPPORTED_REFERENCE", `Script must be .js or .mjs: ${value}`);
    if (kind === "css" && mime !== "text/css") packageError("UNSUPPORTED_REFERENCE", `Stylesheet must be .css: ${value}`);
    if (kind === "module") {
      if (resolved.suffix) packageError("UNSUPPORTED_REFERENCE", "Module query/fragment variants are unsupported");
      return moduleSpecifier(resolved.path);
    }
    if (kind === "fetch") return resolved.path;
    // Keep virtual suffixes intact for validation. The child strips static
    // cache-busting queries only when materializing its Blob resource URLs.
    if (kind === "worker") {
      if (resolved.suffix) packageError("UNSUPPORTED_REFERENCE", "Worker query/fragment variants are unsupported");
      workerPaths.add(resolved.path);
    }
    markers.push({ asset: resolved.path, suffix: resolved.suffix, ...(kind === "worker" ? { worker: true } : {}) });
    return `${MARKER}${markers.length - 1}__`;
  };
  const parts = (text: string): ResourcePart[] => {
    const result: ResourcePart[] = [];
    let offset = 0;
    for (const match of text.matchAll(/__SANDBOX_PACKAGE_ASSET_(\d+)__/g)) {
      result.push(text.slice(offset, match.index), markers[Number(match[1])]!);
      offset = match.index + match[0].length;
    }
    result.push(text.slice(offset));
    return result;
  };
  const decodeText = (path: string): string => {
    const bytes = files[path]!;
    if (bytes.byteLength > LIMITS.textBytes) return packageError("TEXT_TOO_LARGE", `Text exceeds parser limit: ${path}`);
    try { return decoder.decode(bytes); }
    catch { return packageError("INVALID_ENCODING", `Expected UTF-8: ${path}`); }
  };
  const text = (path: string): string => {
    const source = decodeText(path);
    if (source.includes(MARKER)) packageError("RESERVED_TEXT", `Reserved runtime marker: ${path}`);
    return source;
  };
  const transformCss = (source: string, from: string, inline = false): string => {
    let ast: css.CssNode;
    try { ast = css.parse(source, { context: inline ? "declarationList" : "stylesheet", parseCustomProperty: true, onParseError(error) { throw error; } }); }
    catch { return packageError("INVALID_CSS", `Invalid CSS: ${from}`); }
    css.walk(ast, function(node) {
      if (node.type === "Raw") packageError("UNSUPPORTED_CSS", `Unparsed CSS is unsupported: ${from}`);
      const isImport = cssName(this.atrule?.name) === "import";
      if (node.type === "Url") node.value = reference(node.value, from, isImport ? "css" : "asset");
      if (node.type === "String") {
        if (node.value.includes(MARKER)) packageError("RESERVED_TEXT", `Reserved runtime marker in decoded CSS string: ${from}`);
        if (isImport || CSS_IMAGE_SET_FUNCTIONS.has(cssName(this.function?.name))) node.value = reference(node.value, from, isImport ? "css" : "asset");
      }
    });
    // Url nodes serialize an unquoted marker because the marker itself is
    // safe. Its later Blob fragment may contain CSS delimiters, so force a
    // quoted string through the CSS serializer, only in CSS URL contexts.
    css.walk(ast, { visit: "Url", enter(node, item, list) {
      const quoted: css.FunctionNode = {
        type: "Function", name: "url",
        children: new css.List<css.CssNode>().fromArray([{ type: "String", value: node.value }]),
      };
      list.replace(item, list.createItem(quoted));
    } });
    return css.generate(ast, { decorator(handlers) {
      const token = handlers.token;
      // Keep decoded '<' inside CSS strings when this output is inline HTML.
      handlers.token = function(type, value, suppressAutoWhiteSpace) {
        token.call(this, type, type === css.tokenTypes.String ? value.replaceAll("<", "\\3c ") : value, suppressAutoWhiteSpace);
      };
      return handlers;
    } });
  };
  const transformJs = (source: string, from: string, module: boolean, worker = false): string => {
    let ast: Node;
    try { ast = parseJs(source, { ecmaVersion: "latest", sourceType: module ? "module" : "script", allowHashBang: true }); }
    catch { return packageError("INVALID_JAVASCRIPT", `Invalid ${module ? "module" : "classic script"}: ${from}`); }
    const edits: Edit[] = [];
    const literal = (node: unknown): string | undefined => {
      const value = node as JsNode | undefined;
      if (value?.type === "TemplateLiteral" && value.expressions?.length === 0) return value.quasis?.[0]?.value.cooked ?? undefined;
      return value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
    };
    const isImportMetaUrl = (node: JsNode | undefined): boolean => {
      if (node?.type !== "MemberExpression") return false;
      const object = node.object as JsNode;
      return object.type === "MetaProperty" && (object.meta as JsNode).name === "import" &&
        (node.computed ? literal(node.property) : (node.property as JsNode).name) === "url";
    };
    const replaceImport = (node: JsNode) => {
      const sourceNode = node.source as JsNode | undefined;
      if (!sourceNode) return;
      const value = literal(sourceNode);
      if (value === undefined) packageError("DYNAMIC_IMPORT", `import() requires a string literal: ${from}`);
      if (node.options || (Array.isArray(node.attributes) && node.attributes.length)) packageError("UNSUPPORTED_MODULE", "Import attributes are unsupported");
      if (value!.startsWith("npm:")) {
        if (!parseNpmSpecifier(value!)) return packageError("INVALID_NPM_SPECIFIER", "Expected npm:<name>@<exact-version-or-latest>");
        if (worker || isNpmPackagePath(from)) return packageError("UNSUPPORTED_NPM_CONTEXT", "npm imports are not supported inside Worker graphs or cached modules");
        if (specifiers) {
          specifiers.add(value!);
          if (specifiers.size > LIMITS.files) return packageError("PACKAGE_TOO_LARGE", "Too many npm module aliases");
          return;
        }
        const path = aliases && Object.hasOwn(aliases, value!) ? aliases[value!] : undefined;
        if (!path) return packageError("UNSUPPORTED_MODULE", "npm import is missing from the deployment lock");
        edits.push({ start: sourceNode.start, end: sourceNode.end, text: quoteJs(moduleSpecifier(path)) });
        return;
      }
      if (!value!.startsWith("./") && !value!.startsWith("../") && !value!.startsWith("/") && parseInlineDataUrl(value!) === undefined) packageError("UNSUPPORTED_MODULE", `Bare/external module specifier: ${value}`);
      edits.push({ start: sourceNode.start, end: sourceNode.end, text: quoteJs(reference(value!, from, worker ? "worker" : "module")) });
    };
    simple(ast, {
      ImportDeclaration: node => replaceImport(node as JsNode),
      ExportNamedDeclaration: node => replaceImport(node as JsNode),
      ExportAllDeclaration: node => replaceImport(node as JsNode),
      ImportExpression: node => replaceImport(node as JsNode),
      CallExpression(node) {
        const n = node as JsNode;
        const callee = n.callee as JsNode;
        const args = n.arguments as JsNode[];
        if (callee.type === "Identifier" && callee.name === "fetch" && literal(args[0]) !== undefined) {
          reference(literal(args[0])!, "index.html", "fetch");
        }
        // Dynamic-code strings stay opaque; eval/Function permissions are
        // enforced at execution by the iframe/Worker CSP, not AST heuristics.
        if (callee.type === "Identifier" && callee.name === "importScripts") packageError("UNSUPPORTED_DYNAMIC_CODE", `Dynamic code loading is unsupported: ${from}`);
      },
      NewExpression(node) {
        const n = node as JsNode;
        const callee = n.callee as JsNode;
        const args = n.arguments as JsNode[];
        if (callee.type === "Identifier" && ["SharedWorker", "XMLHttpRequest"].includes(String(callee.name))) packageError("UNSUPPORTED_API", `${callee.name} is unsupported in offline packages: ${from}`);
        if (callee.type === "Identifier" && callee.name === "Worker") {
          const arg = args[0];
          let value = literal(arg);
          if (arg?.type === "NewExpression" && (arg.callee as JsNode)?.name === "URL") {
            const urlArgs = arg.arguments as JsNode[];
            if (isImportMetaUrl(urlArgs[1])) {
              value = literal(urlArgs[0]);
              if (value === undefined) packageError("DYNAMIC_RESOURCE", `Worker URL relative to import.meta.url requires a literal: ${from}`);
            }
          }
          // Computed Blob URLs (e.g. Meshopt's worker pool) are checked by the browser at runtime.
          if (value !== undefined) {
            for (let i = edits.length - 1; i >= 0; i--) if (edits[i]!.start >= arg!.start && edits[i]!.end <= arg!.end) edits.splice(i, 1);
            edits.push({ start: arg!.start, end: arg!.end, text: quoteJs(reference(value, from, "worker")) });
          }
        }
        if (callee.type === "Identifier" && callee.name === "URL" && isImportMetaUrl(args[1])) {
          const value = literal(args[0]);
          if (value !== undefined) edits.push({ start: n.start, end: n.end, text: `new URL(${quoteJs(reference(value, from))})` });
          else if (worker) packageError("DYNAMIC_RESOURCE", `Worker new URL(..., import.meta.url) requires a literal: ${from}`);
          // Document modules resolve computed paths from their Blob URL at runtime.
        }
      },
    });
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    return source;
  };
  const transformHtml = (source: string): string => {
    const doc = parseHtml(source);
    const rejectReserved = (node: HtmlNode): void => {
      if (("value" in node && typeof node.value === "string" && node.value.includes(MARKER)) ||
          ("attrs" in node && node.attrs.some(attribute => attribute.value.includes(MARKER)))) packageError("RESERVED_TEXT", "Reserved runtime marker in decoded HTML");
      if ("childNodes" in node) node.childNodes.forEach(rejectReserved);
      if ("content" in node && node.content) rejectReserved(node.content);
    };
    rejectReserved(doc);
    const dropped = new Set<HtmlNode>();
    const dropMarked = (parent: { childNodes: DefaultTreeAdapterMap["childNode"][] }): void => {
      if (dropped.size) parent.childNodes = parent.childNodes.filter(child => !dropped.has(child));
    };
    // Returns the reference kind for a kept link, or null for a hint-only link
    // that was scrubbed from the document.
    const classifyLink = (node: DefaultTreeAdapterMap["element"]): "css" | "asset" | null => {
      const find = (name: string) => node.attrs.find(item => item.name === name);
      const rel = find("rel");
      const href = find("href")?.value;
      const tokens = [...new Set((rel?.value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean))];
      if (rel) rel.value = tokens.join(" ");
      const unsupported = tokens.find(token => token !== "stylesheet" && !INERT_LINK_RELATIONS.has(token));
      if (unsupported !== undefined) packageError("UNSUPPORTED_HTML_LINK", `Unsupported link relation: ${unsupported}`);
      if (!tokens.length) {
        if (href !== undefined) packageError("UNSUPPORTED_HTML_LINK", "Unsupported link relation: (missing)");
        return "asset";
      }
      // A hint mixed with a direct relation keeps the direct behaviour and drops
      // only the hint tokens: the hint half is redundant offline and must not
      // make the browser preload a Blob URL it is already loading.
      if (tokens.includes("stylesheet")) {
        rel!.value = "stylesheet";
        return "css";
      }
      // Hint-only tags are scrubbed rather than validated or rewritten: the tag
      // never reaches the executable document, so its href, as and srcset can
      // neither fetch nor reach the child, and a CDN hint no longer fails upload.
      dropped.add(node);
      return null;
    };
    // Each candidate is a URL terminated by ASCII whitespace, followed by an
    // optional descriptor that runs to the next comma. Commas are legal inside a
    // URL, so splitting the list on commas first would corrupt them, and only the
    // HTML whitespace set ends a URL (a NBSP or U+2028 belongs to the URL). The
    // descriptor is opaque metadata kept verbatim (1.5x, 100w, surrounding spaces).
    const SRC_SET_WHITESPACE = /[\t\n\f\r ]/;
    const splitSrcset = (value: string): { url: string; descriptor: string }[] => {
      const candidates: { url: string; descriptor: string }[] = [];
      let index = 0;
      while (index < value.length) {
        while (index < value.length && (value[index] === "," || SRC_SET_WHITESPACE.test(value[index]!))) index++;
        if (index >= value.length) break;
        let url = "";
        while (index < value.length && !SRC_SET_WHITESPACE.test(value[index]!)) url += value[index++]!;
        const separator = /,+$/.exec(url);
        if (separator) {
          // Trailing commas belong to the list, not to the URL.
          const bare = url.slice(0, -separator[0].length);
          if (bare) candidates.push({ url: bare, descriptor: "" });
          continue;
        }
        let descriptor = "";
        while (index < value.length && value[index] !== ",") descriptor += value[index++]!;
        index++; // Consume the separator; the loop skips any extra comma.
        candidates.push({ url, descriptor });
      }
      return candidates;
    };
    const rewriteSrcset = (value: string): string => splitSrcset(value)
      .map(candidate => `${reference(candidate.url, "index.html", "asset")}${candidate.descriptor}`)
      .join(", ");
    // A dropped tag never validates its reference, so resolution failure only
    // means there is no path to exclude from compilation.
    const optionalPackagePath = (value: string): string | undefined => {
      try { return resolvePackageReference(value, "index.html").path; }
      catch { return undefined; }
    };
    const visit = (node: HtmlNode): void => {
      if ("tagName" in node) {
        const tag = node.tagName.toLowerCase();
        let linkKind: "css" | "asset" = "asset";
        if (tag === "link") {
          const classification = classifyLink(node);
          if (classification === null) return; // Hint-only tag: scrubbed from the document.
          linkKind = classification;
          // A responsive set on a stylesheet link is meaningless there.
          node.attrs = node.attrs.filter(attribute => attribute.name !== "imagesrcset");
        }
        const attr = (name: string) => node.attrs.find(item => item.name === name);
        node.attrs = node.attrs.filter(attribute => !INERT_ATTRIBUTES.has(attribute.name));
        if (UNSUPPORTED_ELEMENTS.has(tag)) packageError("UNSUPPORTED_HTML_ELEMENT", `Unsupported HTML element: ${tag}`);
        if (tag === "meta" && attr("http-equiv")) {
          // A refresh replaces the document by navigation; every other
          // http-equiv pragma is inert in an offline srcdoc and is dropped.
          if (attr("http-equiv")!.value.trim().toLowerCase() !== "refresh") { dropped.add(node); return; }
          packageError("UNSUPPORTED_HTML_ELEMENT", "Unsupported HTML element: meta refresh");
        }
        if (tag === "script") {
          const type = attr("type")?.value.toLowerCase() ?? "";
          if (!["", "text/javascript", "application/javascript", "module", "application/json"].includes(type)) packageError("UNSUPPORTED_HTML_SCRIPT", `Unsupported script type: ${type}`);
          if (attr("type")) attr("type")!.value = type;
          // `nomodule` only suppresses executing classic scripts; a module script
          // still runs and a data block is not executed at all, so only the
          // executable classic case loses the element entirely: its src is neither
          // rewritten nor materialized, and its file is not parsed.
          if (attr("nomodule")) {
            if (type === "module" || type === "application/json") node.attrs = node.attrs.filter(attribute => attribute.name !== "nomodule");
            else {
              const src = attr("src")?.value;
              const path = src === undefined ? undefined : optionalPackagePath(src);
              if (path !== undefined) droppedScriptPaths.add(path);
              dropped.add(node);
              return;
            }
          }
          if (attr("src") && type === "application/json") packageError("UNSUPPORTED_HTML_SCRIPT", "JSON script blocks must be inline");
          if (!attr("src") && type !== "application/json") {
            const scriptText = node.childNodes.filter(child => child.nodeName === "#text").map(child => (child as DefaultTreeAdapterMap["textNode"]).value).join("");
            const transformed = transformJs(scriptText, "index.html", type === "module");
            node.childNodes = [{ nodeName: "#text", value: transformed, parentNode: node }];
          }
        }
        if (tag === "style") {
          const styleText = node.childNodes.map(child => (child as DefaultTreeAdapterMap["textNode"]).value ?? "").join("");
          node.childNodes = [{ nodeName: "#text", value: transformCss(styleText, "index.html"), parentNode: node }];
        }
        for (const attribute of node.attrs) {
          const name = attribute.name;
          if (name.startsWith("on")) { attribute.value = transformJs(attribute.value, "index.html", false); continue; }
          if (name === "style") { attribute.value = transformCss(attribute.value, "index.html", true); continue; }
          if (name === "srcset" || name === "imagesrcset") { attribute.value = rewriteSrcset(attribute.value); continue; }
          // `background` is a legacy image reference on body/table cells.
          if (name === "background") { attribute.value = reference(attribute.value, "index.html", "asset"); continue; }
          if (name === "action" || name === "formaction") packageError("UNSUPPORTED_HTML_FORM", "Form submission is unsupported");
          if (name === "href" && (tag === "a" || tag === "area")) {
            if (activeHrefScheme(attribute.value)) packageError("UNSUPPORTED_HTML_ELEMENT", "Active navigation schemes are unsupported");
          } else if (["src", "href", "poster", "data"].includes(name)) {
            if (tag === "link") attribute.value = reference(attribute.value, "index.html", linkKind);
            else {
              const value = attribute.value;
              const moduleScript = tag === "script" && attr("type")?.value === "module";
              if (moduleScript) reference(value, "index.html", "module");
              attribute.value = reference(value, "index.html", tag === "script" ? "script" : "asset");
              if (tag === "script" && !moduleScript) classicPaths.add(resolvePackageReference(value, "index.html").path);
            }
          }
        }
      }
      if ("childNodes" in node) {
        for (const child of node.childNodes) visit(child);
        dropMarked(node);
      }
      if ("content" in node && node.content) {
        visit(node.content);
        dropMarked(node.content);
      }
    };
    visit(doc);
    return serialize(doc);
  };
  const resources: CompiledResource[] = [];
  const html = parts(transformHtml(text("index.html")));
  // Parse every JS as a module (a superset of most classic sources); script-tag
  // classic mode is checked separately by the browser. All imports are mapped.
  for (const path of Object.keys(files)) {
    const mime = knownResourceMime(path);
    // Fallback data has no automatic Blob. Known .bin keeps its existing Blob
    // behavior despite sharing application/octet-stream with fallback files.
    if (mime === undefined) continue;
    // Skip a file only a removed nomodule script pointed at. Any live reference
    // (asset, script, module specifier, fetch target) keeps it in compilation.
    if (droppedScriptPaths.has(path) && !referencedPaths.has(path)) continue;
    if (mime === "text/html") {
      // Only root index.html is compiled above. Secondary HTML is verified
      // UTF-8 data for local fetch, not parsed, rewritten or made into a Blob.
      if (path !== "index.html") decodeText(path);
      continue;
    }
    let transformed: string | null = null;
    if (mime === "text/javascript") {
      const source = text(path);
      if (classicPaths.has(path)) transformJs(source, path, false);
      transformed = transformJs(source, path, true);
    }
    if (mime === "text/css") transformed = transformCss(text(path), path);
    if (mime === "image/svg+xml") {
      const svg = text(path);
      const fragment = parseFragment(svg);
      const checkCss = (source: string, property?: string) => {
        let value: css.CssNode;
        try {
          value = css.parse(source, { context: property === undefined ? "declarationList" : "value", parseCustomProperty: true, onParseError(error) { throw error; } });
        } catch { return packageError("UNSUPPORTED_SVG", `Invalid SVG CSS: ${path}`); }
        css.walk(value, function(child) {
          if (child.type === "Raw") packageError("UNSUPPORTED_SVG", `Unparsed SVG CSS is unsupported: ${path}`);
          const functionName = cssName(this.function?.name);
          // css-tree emits Url nodes for url(), but an escaped function name or
          // an image-set() string can also carry a URL.
          const stringUrl = child.type === "String" && (functionName === "url" || functionName === "src" || functionName === "image" || CSS_IMAGE_SET_FUNCTIONS.has(functionName));
          if (child.type === "Url" || stringUrl) {
            const name = cssName(this.declaration?.property ?? property);
            if (!SVG_URL_PROPERTIES.has(name) || !child.value.startsWith("#")) packageError("UNSUPPORTED_SVG", `SVG CSS only supports local fragment URLs in presentation properties: ${path}`);
          }
        });
      };
      const check = (node: HtmlNode) => {
        if ("tagName" in node) {
          if (["script", "foreignObject", "image", "use", "style", "animate", "animateMotion", "animateTransform", "set"].includes(node.tagName) || node.attrs.some(a => a.name.startsWith("on") || (a.name === "href" && !a.value.startsWith("#")))) packageError("UNSUPPORTED_SVG", `SVG must be self-contained and non-scripted: ${path}`);
          for (const attribute of node.attrs) {
            if (attribute.name === "style") checkCss(attribute.value);
            else if (SVG_URL_PROPERTIES.has(attribute.name)) checkCss(attribute.value, attribute.name);
          }
        }
        if ("childNodes" in node) node.childNodes.forEach(check);
      };
      check(fragment);
    }
    resources.push({ path, mime, parts: transformed === null ? null : parts(transformed) });
  }
  // Only statically reachable worker graphs need a second compilation. Workers
  // have no document import map, so their module edges become direct Blob URLs.
  const workers: CompiledResource[] = [];
  for (const path of workerPaths) workers.push({ path, mime: "text/javascript", parts: parts(transformJs(text(path), path, true, true)) });
  // Blob dependencies must be acyclic; document ESM cycles still use import maps.
  const byPath = new Map(resources.map(resource => [resource.path, resource]));
  const active = new Set<string>(); const done = new Set<string>();
  const workerByPath = new Map(workers.map(resource => [resource.path, resource]));
  const checkCycle = (path: string, worker = false) => {
    const key = `${worker ? "worker:" : "asset:"}${path}`;
    if (active.has(key)) packageError("RESOURCE_CYCLE", `Cyclic Blob resource references: ${path}`);
    if (done.has(key)) return;
    active.add(key);
    for (const part of (worker ? workerByPath : byPath).get(path)?.parts ?? []) if (typeof part !== "string") checkCycle(part.asset, part.worker);
    active.delete(key); done.add(key);
  };
  for (const path of byPath.keys()) checkCycle(path);
  for (const path of workerByPath.keys()) checkCycle(path, true);
  const plan = { resources, workers, html };
  if (encoder.encode(JSON.stringify(plan)).byteLength > LIMITS.compiledBytes) packageError("PACKAGE_TOO_LARGE", "Compiled package budget exceeded");
  return plan;
}

/** Internal only. Called exclusively with our own compiler worker's result. */
export function adoptPreparedSnapshot(snapshot: PackageSnapshot): PreparedSandboxPackage {
  const { manifest, totalBytes } = validatePackageManifest(snapshot.manifest);
  if (totalBytes !== snapshot.totalBytes) packageError("INTEGRITY", "Invalid prepared byte budget");
  const prepared: PreparedSandboxPackage = Object.freeze({ runtimeVersion: SANDBOX_RUNTIME_VERSION, totalBytes, manifest, [preparedBrand]: true as const });
  snapshots.set(prepared, { ...snapshot, manifest });
  return prepared;
}
