import { moduleSpecifier, isSystemJsAlias, resolvePackageReference } from "./package-format.js";
import { isNpmPackagePath } from "./package-npm.js";
import { PACKAGE_SYSTEMJS_SOURCE } from "./package-systemjs-source.js";

type ExportValues = (values: Record<string, unknown>) => void;
type ModuleDeclaration = (exportValues: ExportValues) => unknown;
type Registration = readonly [deps: readonly string[], declare: ModuleDeclaration];
type ModuleRegistration = { path: string; name?: string; definition: Registration };
type SystemLoader = {
  import(specifier: string, parent?: string, meta?: unknown): Promise<unknown>;
  register(...args: unknown[]): void;
  resolve(specifier: string, parent?: string, meta?: unknown): string;
  instantiate(id: string): Promise<Registration>;
  prepareImport(): void;
  createContext(id: string): { url: string; resolve: (specifier: string) => Promise<string> };
};

const NativeURL = URL;
const NAMED_ID_PREFIX = "sandbox-systemjs-name:";
const namedId = (name: string): string => `${NAMED_ID_PREFIX}${encodeURIComponent(name)}`;
const isVirtualName = (name: string): boolean => /^[a-z][a-z\d+.-]*:\/\/\/[^?#\s\\]+$/i.test(name) &&
  !/^(?:https?|file|blob|data|javascript|vbscript|npm|sandbox-package|sandbox-systemjs-name):/i.test(name);
const isLocalReference = (value: string): boolean => /^(?:\.{1,2}\/|\/(?!\/))/.test(value);

function appendClassicScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (loaded: boolean) => {
      script.remove();
      if (loaded) resolve();
      else reject(new TypeError("Offline SystemJS script failed to load"));
    };
    script.addEventListener("load", () => finish(true), { once: true });
    script.addEventListener("error", () => finish(false), { once: true });
    script.src = url;
    document.head.append(script);
  });
}

/** Attach the package resolver where SystemJS would normally select/fetch a URL. */
export async function installPackageSystemJs(options: {
  imports: Readonly<Record<string, string>>;
  scriptUrl(path: string): string | undefined;
  scriptPath(url: string): string | undefined;
  createRuntimeUrl(source: string): string;
}): Promise<(entry: string) => Promise<unknown>> {
  const { imports, scriptUrl, scriptPath } = options;
  const scope = window as unknown as { System: unknown };
  const configured = new WeakSet<SystemLoader>();

  const configure = (value: unknown): SystemLoader => {
    const loader = value as SystemLoader | undefined;
    if (!loader || typeof loader !== "object" || typeof loader.import !== "function" || typeof loader.register !== "function") {
      throw new TypeError("Offline SystemJS requires a System.register loader");
    }
    if (configured.has(loader)) return loader;
    configured.add(loader);
    const nativeImport = loader.import.bind(loader);
    const registrations = new Map<string, ModuleRegistration>();
    const loadedScripts = new Map<string, Promise<void>>();
    const paths = new Map<string, string>();
    const entriesByPath = new Map<string, string>();
    const currentScriptPath = () => document.currentScript instanceof HTMLScriptElement
      ? scriptPath(document.currentScript.src) : undefined;

    const resolvePath = (path: string): string => {
      if (isNpmPackagePath(path) || !scriptUrl(path)) throw new TypeError("Offline SystemJS dependency must be a compiled package script");
      const id = moduleSpecifier(path);
      paths.set(id, path);
      return id;
    };

    const resolve = (specifier: string, parent?: string, meta?: unknown): string => {
      if (typeof specifier !== "string" || meta !== undefined) throw new TypeError("Unsupported offline SystemJS import");
      if (paths.has(specifier)) return specifier;
      if (specifier.startsWith(NAMED_ID_PREFIX) && registrations.has(specifier)) return specifier;
      if (Object.hasOwn(imports, specifier)) return resolvePath(imports[specifier]!);
      const nameId = namedId(specifier);
      if (registrations.has(nameId)) return nameId;
      if (!isLocalReference(specifier)) throw new TypeError("Offline SystemJS could not resolve a package module");
      const registration = parent ? registrations.get(parent) : undefined;
      if (registration && registration.name && isVirtualName(registration.name)) {
        const candidate = namedId(new NativeURL(specifier, registration.name).href);
        if (registrations.has(candidate)) return candidate;
      }
      const base = parent === undefined ? "index.html" : paths.get(parent) ?? registration?.path ?? scriptPath(parent);
      if (!base) throw new TypeError("Offline SystemJS requires a package module as the import base");
      const { path, suffix } = resolvePackageReference(specifier, base);
      if (suffix) throw new TypeError("Offline SystemJS modules do not accept query or fragment variants");
      return resolvePath(path);
    };

    loader.resolve = resolve;
    loader.prepareImport = () => {};
    loader.import = (specifier, parent, meta) => {
      const current = currentScriptPath();
      return nativeImport(specifier, parent ?? (current ? resolvePath(current) : undefined), meta);
    };
    loader.register = (...args) => {
      const name = typeof args[0] === "string" ? args.shift() as string : undefined;
      const [deps, declare, meta] = args;
      if (!Array.isArray(deps) || deps.some(dep => typeof dep !== "string") || typeof declare !== "function" || meta !== undefined ||
          (name !== undefined && !isSystemJsAlias(name) && !isVirtualName(name))) {
        throw new TypeError("Invalid offline SystemJS registration");
      }
      const path = currentScriptPath();
      if (!path && name === undefined) throw new TypeError("An anonymous SystemJS registration needs a package script file");
      const id = name === undefined ? resolvePath(path!) : namedId(name);
      if (registrations.has(id)) throw new TypeError("Duplicate offline SystemJS module registration");
      registrations.set(id, { path: path ?? "index.html", ...(name === undefined ? {} : { name }), definition: [deps, declare as ModuleDeclaration] });
      // A file that bundles only named modules uses its first registration as
      // the default entry. Named and file imports share one SystemJS instance.
      if (path && name !== undefined && !entriesByPath.has(path)) entriesByPath.set(path, id);
    };
    loader.instantiate = async id => {
      const existing = registrations.get(id);
      if (existing) return existing.definition;
      const path = paths.get(id);
      const url = path && scriptUrl(path);
      if (!path || !url) throw new TypeError("Offline SystemJS could not load a package module");
      if (!entriesByPath.has(path)) {
        let load = loadedScripts.get(path);
        if (!load) {
          load = appendClassicScript(url);
          loadedScripts.set(path, load);
        }
        await load;
      }
      const direct = registrations.get(id);
      if (direct) return direct.definition;
      const entry = entriesByPath.get(path);
      if (!entry) throw new TypeError("Offline script did not register a SystemJS module");
      // Use the canonical name ID so a work import-map alias matching the
      // registration name cannot redirect this synthetic dependency to itself.
      const definition: Registration = [[entry], exportValues => ({ setters: [exportValues], execute() {} })];
      registrations.set(id, { path, definition });
      return definition;
    };
    loader.createContext = id => ({
      url: scriptUrl(registrations.get(id)?.path ?? paths.get(id) ?? "") ?? document.baseURI,
      resolve: async specifier => resolve(specifier, id),
    });
    return loader;
  };

  await appendClassicScript(options.createRuntimeUrl(PACKAGE_SYSTEMJS_SOURCE));
  let loader = configure(scope.System);
  // Standard exports may carry their own SystemJS distribution. Wire up each
  // loader instance on assignment before its next import in the work document.
  Object.defineProperty(scope, "System", { get: () => loader, set: value => { loader = configure(value); } });
  return entry => loader.import(entry.startsWith("import:") ? entry.slice("import:".length) : entry);
}
