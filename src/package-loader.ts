import { SandboxBridgeClient } from "./client.js";
import type { SandboxGameApiBindings } from "./game-api-config.js";
import { moduleSpecifier, resolvePackageReference, resourceMime, type PackageSnapshot, type ResourcePart } from "./package-format.js";

/** Runs only in the opaque child, after every byte has been received/verified. */
export async function loadSandboxPackage(snapshot: PackageSnapshot, client: SandboxBridgeClient, methods: SandboxGameApiBindings): Promise<() => void> {
  const urls = new Map<string, string>();
  const inlineModuleUrls: string[] = [];
  const workerUrls = new Map<string, string>();
  const workers = new Set<Worker>();
  const NativeWorker = window.Worker;
  const byPath = new Map(snapshot.plan.resources.map(resource => [resource.path, resource]));
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  let initializationError: Error | undefined;
  const onError = () => { initializationError = new Error("Offline package script initialization failed"); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  const stopObserving = () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError); };
  const onLinkClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    if (!target) return;
    event.preventDefault();
    const href = target.getAttribute("href");
    if (href?.startsWith("#")) {
      // srcdoc's fallback base URL is the parent URL. Native href="#..."
      // would otherwise navigate to that HTTP document, not this package.
      window.location.hash = href;
      try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch { /* Invalid fragment is inert. */ }
    }
  };
  document.addEventListener("click", onLinkClick, true);
  const cleanup = () => { document.removeEventListener("click", onLinkClick, true); stopObserving(); client.close(); for (const worker of workers) worker.terminate(); workers.clear(); for (const url of workerUrls.values()) revokeObjectURL(url); workerUrls.clear(); for (const url of urls.values()) revokeObjectURL(url); for (const url of inlineModuleUrls) revokeObjectURL(url); urls.clear(); inlineModuleUrls.length = 0; };
  window.addEventListener("pagehide", cleanup, { once: true });
  const render = (parts: readonly ResourcePart[]): string => parts.map(part => {
    if (typeof part === "string") return part;
    // Blob registry lookup has no query variants. Strip only the virtual
    // search, preserving the entire fragment (including any '?' inside it).
    const hash = part.suffix.indexOf("#");
    return (part.worker ? workerUrl(part.asset) : assetUrl(part.asset)) + (hash < 0 ? "" : part.suffix.slice(hash));
  }).join("");
  const assetUrl = (path: string): string => {
    const known = urls.get(path);
    if (known) return known;
    const resource = byPath.get(path);
    if (!resource) throw new TypeError(`Missing compiled asset: ${path}`);
    const body = resource.parts === null ? new Uint8Array(snapshot.files[path]!) : render(resource.parts);
    const url = createObjectURL(new Blob([body], { type: resource.mime }));
    urls.set(path, url);
    return url;
  };
  const workerByPath = new Map(snapshot.plan.workers.map(resource => [resource.path, resource]));
  const workerUrl = (path: string): string => {
    const known = workerUrls.get(path);
    if (known) return known;
    const resource = workerByPath.get(path);
    if (!resource?.parts) throw new TypeError("Missing compiled Worker resource");
    const url = createObjectURL(new Blob([render(resource.parts)], { type: "text/javascript" }));
    workerUrls.set(path, url);
    return url;
  };
  // Compatibility and lifecycle accounting, not a security boundary. CSP only
  // permits Blob workers; opaque origin and inherited connect-src remain intact.
  class PackageWorker extends NativeWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      if (workers.size >= 32) throw new TypeError("Offline package Worker limit exceeded (32)");
      const url = String(scriptURL);
      if (!url.startsWith("blob:")) throw new TypeError("Worker must use a package file or a child-created Blob URL");
      // Chromium cannot start a native module Worker from an opaque-origin
      // Blob. A classic bootstrap imports the module and queues early messages
      // until its top-level await has settled, preserving Worker startup order.
      const bootstrap = options?.type === "module" ? createObjectURL(new Blob([`
        const pending = [];
        const queue = event => { event.stopImmediatePropagation(); pending.push(event); };
        self.addEventListener("message", queue);
        import(${JSON.stringify(url)}).then(() => {
          self.removeEventListener("message", queue);
          for (const event of pending) self.dispatchEvent(new MessageEvent("message", { data:event.data, ports:event.ports, origin:event.origin, lastEventId:event.lastEventId }));
        }).catch(error => { setTimeout(() => { throw error; }); });
      `], { type: "text/javascript" })) : undefined;
      if (bootstrap) inlineModuleUrls.push(bootstrap);
      super(bootstrap ?? url, { ...options, type: "classic" });
      workers.add(this);
    }
    override terminate(): void { workers.delete(this); super.terminate(); }
  }
  Object.defineProperty(window, "Worker", { value: PackageWorker, configurable: false, writable: false });
  try {
    // Materialize only compiled known assets before user scripts. HTML templates
    // and fallback data stay byte-only and never acquire automatic Blob URLs.
    for (const path of byPath.keys()) assetUrl(path);
    const api: Record<string, (payload: unknown, options?: Parameters<SandboxBridgeClient["call"]>[2]) => Promise<unknown>> = Object.create(null);
    for (const [name, binding] of Object.entries(methods)) {
      api[name] = (payload, options = {}) => client.call(binding.method, payload, { timeoutMs: binding.defaultTimeoutMs, ...options });
    }
    Object.defineProperty(window, "game", { value: Object.freeze(api), enumerable: true, configurable: false, writable: false });

    // Local compatibility layer, NOT a security boundary. It never calls native
    // fetch and is deliberately GET/HEAD-only, rooted at package index.html.
    const blobs = new Map([...urls].map(([path, url]) => [url, path]));
    const localFetch: typeof fetch = async (input, init = {}) => {
      const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" && method !== "HEAD") throw new TypeError("Offline package fetch supports GET/HEAD only");
      const reference = input instanceof Request ? input.url : String(input);
      const path = blobs.get(reference.split(/[?#]/, 1)[0]!) ?? resolvePackageReference(reference, "index.html").path;
      if (!Object.hasOwn(snapshot.files, path)) throw new TypeError(`Missing offline fetch resource: ${reference}`);
      const bytes = snapshot.files[path]!;
      signal?.throwIfAborted();
      return new Response(method === "HEAD" ? null : new Uint8Array(bytes), {
        status: 200, headers: { "Content-Type": resourceMime(path), "Content-Length": String(bytes.byteLength) },
      });
    };
    Object.defineProperty(window, "fetch", { value: localFetch, configurable: false, writable: false });

    const documentSource = new DOMParser().parseFromString(render(snapshot.plan.html), "text/html");
    const scripts = [...documentSource.querySelectorAll("script")].filter(script => script.type !== "application/json");
    const placeholders = scripts.map(script => {
      const marker = documentSource.createElement("template");
      script.replaceWith(marker);
      return { script, marker };
    });
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    // Adopt inert parsed nodes: no uploaded script can run during this step.
    document.documentElement.replaceWith(document.adoptNode(documentSource.documentElement));
    document.querySelectorAll('meta[name="referrer"]').forEach(meta => meta.remove());
    const referrer = document.createElement("meta"); referrer.name = "referrer"; referrer.content = "no-referrer";
    document.head.prepend(policy, referrer);
    const importMap = document.createElement("script");
    importMap.type = "importmap";
    importMap.textContent = JSON.stringify({ imports: Object.fromEntries([...urls].filter(([path]) => byPath.get(path)?.mime === "text/javascript").map(([path, url]) => [moduleSpecifier(path), url])) });
    document.head.append(importMap);

    const stylesheetLoads = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new Promise<void>((resolve, reject) => {
      if (link.sheet) { resolve(); return; }
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => reject(new TypeError("Offline stylesheet failed to load")), { once: true });
    }));
    await Promise.all(stylesheetLoads);
    for (const { script, marker } of placeholders) {
      const executable = document.createElement("script");
      for (const { name, value } of script.attributes) if (name !== "async" && name !== "defer") executable.setAttribute(name, value);
      executable.textContent = script.textContent;
      // Inline module scripts do not provide a reliable load event in all
      // browsers. A child-owned Blob gives them the same completion/error path
      // as external modules (including top-level await).
      if (script.type === "module" && !script.hasAttribute("src")) {
        const url = createObjectURL(new Blob([script.textContent ?? ""], { type: "text/javascript" }));
        inlineModuleUrls.push(url); executable.src = url; executable.textContent = "";
      }
      if (script.type === "module") {
        // script.load can precede top-level-await settlement. Native import()
        // gives the actual module graph evaluation promise, not a fake ready.
        await import(/* @vite-ignore */ executable.src);
        marker.replaceWith(executable);
      } else if (executable.src) {
        await new Promise<void>((resolve, reject) => {
          executable.addEventListener("load", () => resolve(), { once: true });
          executable.addEventListener("error", () => reject(new TypeError("Offline script failed to load")), { once: true });
          marker.replaceWith(executable);
        });
      } else marker.replaceWith(executable);
      if (initializationError) throw initializationError;
    }
    // The original bootstrap document already loaded. Compatibility lifecycle
    // events are replayed once after deterministic document-order execution.
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    window.dispatchEvent(new Event("load"));
    if (initializationError) throw initializationError;
    stopObserving();
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
