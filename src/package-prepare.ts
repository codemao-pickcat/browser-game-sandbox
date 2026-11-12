import { parse as parseHtml, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import * as css from "css-tree";
import { parse as parseJs, type Node } from "acorn";
import { simple } from "acorn-walk";
import {
  SANDBOX_PACKAGE_LIMITS as LIMITS, SANDBOX_RUNTIME_VERSION,
  moduleSpecifier, packageError, resolvePackageReference, resourceMime, validatePackageManifest,
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
type HtmlNode = DefaultTreeAdapterMap["node"];
type JsNode = Node & { name?: string; value?: unknown; source?: unknown; options?: unknown; attributes?: unknown; arguments?: unknown; callee?: unknown; object?: unknown; property?: unknown }; 
type Edit = { start: number; end: number; text: string };

/** No evaluation, DOM, fetch, or other network I/O. Identical validator in Node/browser. */
export async function prepareSandboxPackage(input: SandboxPackageInput): Promise<PreparedSandboxPackage> {
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
  const plan = compilePackage(files);
  const prepared: PreparedSandboxPackage = Object.freeze({ runtimeVersion: SANDBOX_RUNTIME_VERSION, totalBytes, manifest, [preparedBrand]: true as const });
  snapshots.set(prepared, { manifest, files, totalBytes, plan });
  return prepared;
}

/** Internal: never exported by the public entry. Returns fresh transfer-owned bytes. */
export function snapshotPreparedPackage(prepared: PreparedSandboxPackage): PackageSnapshot {
  const snapshot = snapshots.get(prepared);
  if (!snapshot) return packageError("NOT_PREPARED", "Package must come from prepareSandboxPackage in this realm");
  return { ...snapshot, files: Object.fromEntries(Object.entries(snapshot.files).map(([path, bytes]) => [path, new Uint8Array(bytes)])) };
}

export function compilePackage(files: Readonly<Record<string, Uint8Array>>): PackagePlan {
  const markers: { asset: string; suffix: string }[] = [];
  const classicPaths = new Set<string>();
  const reference = (value: string, from: string, kind: "asset" | "script" | "module" | "css" | "fetch" = "asset"): string => {
    if (value.startsWith("#") && kind === "asset") return value;
    const resolved = resolvePackageReference(value, from);
    if (!Object.hasOwn(files, resolved.path)) return packageError("MISSING_RESOURCE", `${from} references missing file: ${value}`);
    const mime = resourceMime(resolved.path);
    if (mime === "text/html" && kind !== "fetch") packageError("UNSUPPORTED_REFERENCE", "HTML is passive fetch data only; HTML assets, subdocuments and navigation are unsupported");
    if ((kind === "module" || kind === "script") && mime !== "text/javascript") packageError("UNSUPPORTED_REFERENCE", `Script must be .js or .mjs: ${value}`);
    if (kind === "css" && mime !== "text/css") packageError("UNSUPPORTED_REFERENCE", `Stylesheet must be .css: ${value}`);
    if (kind === "module") {
      if (resolved.suffix) packageError("UNSUPPORTED_REFERENCE", "Module query/fragment variants are unsupported");
      return moduleSpecifier(resolved.path);
    }
    if (kind === "fetch") return resolved.path;
    // Keep virtual suffixes intact for validation. The child strips static
    // cache-busting queries only when materializing its Blob resource URLs.
    markers.push({ asset: resolved.path, suffix: resolved.suffix });
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
      const isImport = this.atrule?.name.toLowerCase() === "import";
      if (node.type === "Url") node.value = reference(node.value, from, isImport ? "css" : "asset");
      if (node.type === "String" && (isImport || ["image-set", "-webkit-image-set"].includes(this.function?.name.toLowerCase() ?? ""))) {
        node.value = reference(node.value, from, isImport ? "css" : "asset");
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
    return css.generate(ast);
  };
  const transformJs = (source: string, from: string, module: boolean): string => {
    let ast: Node;
    try { ast = parseJs(source, { ecmaVersion: "latest", sourceType: module ? "module" : "script", allowHashBang: true }); }
    catch { return packageError("INVALID_JAVASCRIPT", `Invalid ${module ? "module" : "classic script"}: ${from}`); }
    const edits: Edit[] = [];
    const literal = (node: unknown): string | undefined => {
      const value = node as JsNode | undefined;
      return value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
    };
    const replaceImport = (node: JsNode) => {
      const sourceNode = node.source as JsNode | undefined;
      if (!sourceNode) return;
      const value = literal(sourceNode);
      if (value === undefined) packageError("DYNAMIC_IMPORT", `import() requires a string literal: ${from}`);
      if (node.options || (Array.isArray(node.attributes) && node.attributes.length)) packageError("UNSUPPORTED_MODULE", "Import attributes are unsupported");
      if (!value!.startsWith("./") && !value!.startsWith("../") && !value!.startsWith("/")) packageError("UNSUPPORTED_MODULE", `Bare/external module specifier: ${value}`);
      edits.push({ start: sourceNode.start, end: sourceNode.end, text: JSON.stringify(reference(value!, from, "module")) });
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
        if (callee.type === "Identifier" && (callee.name === "eval" || callee.name === "importScripts")) packageError("UNSUPPORTED_DYNAMIC_CODE", `Dynamic code loading is unsupported: ${from}`);
      },
      NewExpression(node) {
        const n = node as JsNode;
        const callee = n.callee as JsNode;
        const args = n.arguments as JsNode[];
        if (callee.type === "Identifier" && ["Worker", "SharedWorker", "XMLHttpRequest", "Function"].includes(String(callee.name))) packageError("UNSUPPORTED_API", `${callee.name} is unsupported in offline packages: ${from}`);
        if (callee.type === "Identifier" && callee.name === "URL") {
          const base = args[1] as JsNode | undefined;
          if (base?.type === "MemberExpression" && (base.object as JsNode)?.type === "MetaProperty" && (base.property as JsNode)?.name === "url") {
            const value = literal(args[0]);
            if (value === undefined) packageError("DYNAMIC_RESOURCE", `new URL(..., import.meta.url) requires a literal: ${from}`);
            edits.push({ start: n.start, end: n.end, text: `new URL(${JSON.stringify(reference(value!, from))})` });
          }
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
    const visit = (node: HtmlNode): void => {
      if ("tagName" in node) {
        const tag = node.tagName.toLowerCase();
        const attr = (name: string) => node.attrs.find(item => item.name === name);
        if (["base", "iframe", "frame", "frameset", "object", "embed", "applet", "portal"].includes(tag) || (tag === "meta" && attr("http-equiv"))) packageError("UNSUPPORTED_HTML", `Unsupported HTML element: ${tag}`);
        if (tag === "script") {
          const type = attr("type")?.value.toLowerCase() ?? "";
          if (!["", "text/javascript", "application/javascript", "module", "application/json"].includes(type)) packageError("UNSUPPORTED_HTML", `Unsupported script type: ${type}`);
          if (attr("type")) attr("type")!.value = type;
          if (attr("src") && type === "application/json") packageError("UNSUPPORTED_HTML", "JSON script blocks must be inline");
          if (attr("nomodule") || attr("integrity")) packageError("UNSUPPORTED_HTML", "nomodule/integrity scripts are unsupported");
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
          if (["srcset", "imagesrcset", "srcdoc", "ping", "manifest", "codebase", "archive", "background"].includes(name)) packageError("UNSUPPORTED_HTML", `Unsupported dynamic/multi-URL attribute: ${name}`);
          if (name === "action" || name === "formaction") packageError("UNSUPPORTED_HTML", "Form submission is unsupported");
          if (name === "href" && (tag === "a" || tag === "area")) {
            if (!attribute.value.startsWith("#")) packageError("UNSUPPORTED_HTML", "Only fragment navigation is supported");
          } else if (["src", "href", "poster", "data"].includes(name)) {
            if (tag === "link") {
              const rel = attr("rel")?.value.toLowerCase();
              if (attr("rel") && rel) attr("rel")!.value = rel;
              if (rel !== "stylesheet" && rel !== "icon") packageError("UNSUPPORTED_HTML", `Unsupported link relation: ${rel}`);
              attribute.value = reference(attribute.value, "index.html", rel === "stylesheet" ? "css" : "asset");
            } else {
              if (tag === "script") {
                if (attr("type")?.value === "module") reference(attribute.value, "index.html", "module");
                else classicPaths.add(resolvePackageReference(attribute.value, "index.html").path);
              }
              attribute.value = reference(attribute.value, "index.html", tag === "script" ? "script" : "asset");
            }
          }
        }
      }
      if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      if ("content" in node && node.content) visit(node.content);
    };
    visit(doc);
    return serialize(doc);
  };
  const resources: CompiledResource[] = [];
  const html = parts(transformHtml(text("index.html")));
  // Parse every JS as a module (a superset of most classic sources); script-tag
  // classic mode is checked separately by the browser. All imports are mapped.
  for (const path of Object.keys(files)) {
    const mime = resourceMime(path);
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
      const check = (node: HtmlNode) => {
        if ("tagName" in node) {
          if (["script", "foreignObject", "image", "use", "style", "animate", "animateMotion", "animateTransform", "set"].includes(node.tagName) || node.attrs.some(a => a.name.startsWith("on") || a.name === "style" || (a.name === "href" && !a.value.startsWith("#")))) packageError("UNSUPPORTED_SVG", `SVG must be self-contained and non-scripted: ${path}`);
          for (const attribute of node.attrs) {
            if (["fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"].includes(attribute.name)) {
              let value: css.CssNode;
              try { value = css.parse(attribute.value, { context: "value" }); }
              catch { return packageError("UNSUPPORTED_SVG", `Invalid SVG presentation attribute: ${path}`); }
              css.walk(value, child => {
                if (child.type === "Raw" || (child.type === "Url" && !child.value.startsWith("#"))) packageError("UNSUPPORTED_SVG", `SVG external references are unsupported: ${path}`);
              });
            }
          }
        }
        if ("childNodes" in node) node.childNodes.forEach(check);
      };
      check(fragment);
    }
    resources.push({ path, mime, parts: transformed === null ? null : parts(transformed) });
  }
  // CSS Blob dependencies must be acyclic; ESM cycles use import maps instead.
  const byPath = new Map(resources.map(resource => [resource.path, resource]));
  const active = new Set<string>(); const done = new Set<string>();
  const checkCycle = (path: string) => {
    if (active.has(path)) packageError("RESOURCE_CYCLE", `Cyclic Blob resource references: ${path}`);
    if (done.has(path)) return;
    active.add(path);
    for (const part of byPath.get(path)?.parts ?? []) if (typeof part !== "string") checkCycle(part.asset);
    active.delete(path); done.add(path);
  };
  for (const path of byPath.keys()) checkCycle(path);
  const plan = { resources, html };
  if (encoder.encode(JSON.stringify(plan)).byteLength > LIMITS.compiledBytes) packageError("PACKAGE_TOO_LARGE", "Compiled package budget exceeded");
  return plan;
}
