import { assertValidOrigin } from "./protocol.js";

export const BROWSER_CAPABILITIES = {
  localStorage: "browser.storage.local",
  indexedDb: "browser.storage.indexeddb",
  dedicatedWorker: "browser.worker.dedicated",
  sharedWorker: "browser.worker.shared",
  serviceWorker: "browser.worker.service",
  wasm: "browser.wasm",
  webgl: "browser.webgl",
  webAudio: "browser.webaudio",
  fullscreen: "browser.fullscreen",
  pointerLock: "browser.pointer-lock",
  clipboardRead: "browser.clipboard.read",
  clipboardWrite: "browser.clipboard.write",
  camera: "browser.camera",
  microphone: "browser.microphone",
  geolocation: "browser.geolocation",
  notifications: "browser.notifications",
  popup: "browser.popup",
  topNavigation: "browser.top-navigation",
  formSubmission: "browser.form-submit",
  download: "browser.download",
  modals: "browser.modals",
  presentation: "browser.presentation",
  networkConnect: "network.connect",
  websocket: "network.websocket",
  webRtc: "network.webrtc",
} as const;

export type BrowserCapability =
  (typeof BROWSER_CAPABILITIES)[keyof typeof BROWSER_CAPABILITIES];

export type BrowserCapabilityEnforcement =
  | "enforced"
  | "declarative"
  | "not-granted";

export interface BrowserPolicyOptions {
  readonly gameOrigin: string;
  readonly hostOrigins?: readonly string[];
  readonly capabilities: readonly BrowserCapability[];
  readonly networkOrigins?: readonly string[];
  readonly scriptNonces?: readonly string[];
}

export interface BrowserPolicy {
  readonly grantedCapabilities: readonly BrowserCapability[];
  readonly sandboxTokens: readonly string[];
  readonly iframeAllow: readonly string[];
  readonly contentSecurityPolicy: string;
  readonly permissionsPolicy: string;
  readonly enforcement: Readonly<Record<BrowserCapability, BrowserCapabilityEnforcement>>;
  readonly warnings: readonly string[];
}

const permissionPolicyFeatures = [
  ["camera", BROWSER_CAPABILITIES.camera],
  ["microphone", BROWSER_CAPABILITIES.microphone],
  ["geolocation", BROWSER_CAPABILITIES.geolocation],
  ["notifications", BROWSER_CAPABILITIES.notifications],
  ["fullscreen", BROWSER_CAPABILITIES.fullscreen],
  ["clipboard-read", BROWSER_CAPABILITIES.clipboardRead],
  ["clipboard-write", BROWSER_CAPABILITIES.clipboardWrite],
] as const;

const enforcementByCapability: Record<
  BrowserCapability,
  "enforced" | "declarative"
> = {
  [BROWSER_CAPABILITIES.localStorage]: "declarative",
  [BROWSER_CAPABILITIES.indexedDb]: "declarative",
  [BROWSER_CAPABILITIES.dedicatedWorker]: "enforced",
  [BROWSER_CAPABILITIES.sharedWorker]: "declarative",
  [BROWSER_CAPABILITIES.serviceWorker]: "enforced",
  [BROWSER_CAPABILITIES.wasm]: "enforced",
  [BROWSER_CAPABILITIES.webgl]: "declarative",
  [BROWSER_CAPABILITIES.webAudio]: "declarative",
  [BROWSER_CAPABILITIES.fullscreen]: "enforced",
  [BROWSER_CAPABILITIES.pointerLock]: "enforced",
  [BROWSER_CAPABILITIES.clipboardRead]: "enforced",
  [BROWSER_CAPABILITIES.clipboardWrite]: "enforced",
  [BROWSER_CAPABILITIES.camera]: "enforced",
  [BROWSER_CAPABILITIES.microphone]: "enforced",
  [BROWSER_CAPABILITIES.geolocation]: "enforced",
  [BROWSER_CAPABILITIES.notifications]: "enforced",
  [BROWSER_CAPABILITIES.popup]: "enforced",
  [BROWSER_CAPABILITIES.topNavigation]: "enforced",
  [BROWSER_CAPABILITIES.formSubmission]: "enforced",
  [BROWSER_CAPABILITIES.download]: "enforced",
  [BROWSER_CAPABILITIES.modals]: "enforced",
  [BROWSER_CAPABILITIES.presentation]: "enforced",
  [BROWSER_CAPABILITIES.networkConnect]: "enforced",
  [BROWSER_CAPABILITIES.websocket]: "enforced",
  [BROWSER_CAPABILITIES.webRtc]: "declarative",
};

export function isBrowserCapability(value: string): value is BrowserCapability {
  return (Object.values(BROWSER_CAPABILITIES) as readonly string[]).includes(value);
}

export function assertBrowserCapabilities(
  capabilities: readonly string[],
): void {
  for (const capability of capabilities) {
    if (!isBrowserCapability(capability)) {
      throw new TypeError(`Unknown browser capability: ${capability}`);
    }
  }
}

export function buildBrowserPolicy(options: BrowserPolicyOptions): BrowserPolicy {
  assertValidOrigin(options.gameOrigin);
  assertBrowserCapabilities(options.capabilities);
  for (const origin of options.hostOrigins ?? []) assertValidOrigin(origin);
  for (const origin of options.networkOrigins ?? []) assertNetworkOrigin(origin);

  const granted = new Set(options.capabilities);
  const warnings: string[] = [];
  const sandboxTokens = ["allow-scripts", "allow-same-origin"];
  const iframeAllow: string[] = [];

  if (granted.has(BROWSER_CAPABILITIES.popup)) sandboxTokens.push("allow-popups");
  if (granted.has(BROWSER_CAPABILITIES.topNavigation)) {
    sandboxTokens.push("allow-top-navigation-by-user-activation");
  }
  if (granted.has(BROWSER_CAPABILITIES.formSubmission)) sandboxTokens.push("allow-forms");
  if (granted.has(BROWSER_CAPABILITIES.download)) sandboxTokens.push("allow-downloads");
  if (granted.has(BROWSER_CAPABILITIES.modals)) sandboxTokens.push("allow-modals");
  if (granted.has(BROWSER_CAPABILITIES.pointerLock)) sandboxTokens.push("allow-pointer-lock");
  if (granted.has(BROWSER_CAPABILITIES.presentation)) sandboxTokens.push("allow-presentation");

  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.fullscreen, "fullscreen", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.pointerLock, "pointer-lock", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.clipboardRead, "clipboard-read", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.clipboardWrite, "clipboard-write", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.camera, "camera", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.microphone, "microphone", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.geolocation, "geolocation", options.gameOrigin);
  addIframeAllow(iframeAllow, granted, BROWSER_CAPABILITIES.notifications, "notifications", options.gameOrigin);

  const workerSources = buildWorkerSources(granted, warnings);
  const connectSources = buildConnectSources(granted, options.networkOrigins ?? []);
  const scriptSources = ["'self'"];
  for (const nonce of options.scriptNonces ?? []) {
    scriptSources.push(`'nonce-${nonce}'`);
  }
  if (granted.has(BROWSER_CAPABILITIES.wasm)) scriptSources.push("'wasm-unsafe-eval'");

  const frameAncestors = options.hostOrigins?.length
    ? options.hostOrigins.join(" ")
    : "'none'";
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `worker-src ${workerSources.join(" ")}`,
    "img-src 'self'",
    "media-src 'self'",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${granted.has(BROWSER_CAPABILITIES.formSubmission) ? "'self'" : "'none'"}`,
    "child-src 'none'",
    "frame-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");

  const permissionsPolicy = permissionPolicyFeatures
    .map(([feature, capability]) =>
      `${feature}=${granted.has(capability) ? `(${options.gameOrigin})` : "()"}`,
    )
    .join(", ");

  if (granted.has(BROWSER_CAPABILITIES.localStorage) || granted.has(BROWSER_CAPABILITIES.indexedDb)) {
    warnings.push("Stable same-origin storage cannot be reliably revoked by a normal web page.");
  }
  if (granted.has(BROWSER_CAPABILITIES.webgl) || granted.has(BROWSER_CAPABILITIES.webAudio)) {
    warnings.push("WebGL and WebAudio are declarative profile entries; ordinary browser pages cannot hard-disable them per game.");
  }
  if (granted.has(BROWSER_CAPABILITIES.webRtc)) {
    warnings.push("WebRTC is not fully controlled by CSP or Permissions-Policy in ordinary browsers.");
  }
  if (granted.has(BROWSER_CAPABILITIES.sharedWorker) !== granted.has(BROWSER_CAPABILITIES.dedicatedWorker)) {
    warnings.push("CSP worker-src cannot reliably distinguish Dedicated Worker from Shared Worker.");
  }

  const enforcement = {} as Record<BrowserCapability, BrowserCapabilityEnforcement>;
  for (const capability of Object.values(BROWSER_CAPABILITIES)) {
    enforcement[capability] = granted.has(capability)
      ? enforcementByCapability[capability]
      : "not-granted";
  }

  return {
    grantedCapabilities: [...granted],
    sandboxTokens,
    iframeAllow,
    contentSecurityPolicy,
    permissionsPolicy,
    enforcement,
    warnings,
  };
}

function buildWorkerSources(
  granted: ReadonlySet<BrowserCapability>,
  warnings: string[],
): string[] {
  if (granted.has(BROWSER_CAPABILITIES.serviceWorker)) {
    warnings.push("Service Worker permission allows same-origin worker scripts and cannot be separated from other worker types by CSP alone.");
    return ["'self'", "blob:"];
  }
  if (
    granted.has(BROWSER_CAPABILITIES.dedicatedWorker) ||
    granted.has(BROWSER_CAPABILITIES.sharedWorker)
  ) {
    return ["blob:"];
  }
  return ["'none'"];
}

function buildConnectSources(
  granted: ReadonlySet<BrowserCapability>,
  networkOrigins: readonly string[],
): string[] {
  if (
    !granted.has(BROWSER_CAPABILITIES.networkConnect) &&
    !granted.has(BROWSER_CAPABILITIES.websocket)
  ) {
    return ["'none'"];
  }
  return ["'self'", ...networkOrigins];
}

function addIframeAllow(
  output: string[],
  granted: ReadonlySet<BrowserCapability>,
  capability: BrowserCapability,
  feature: string,
  gameOrigin: string,
): void {
  if (granted.has(capability)) output.push(`${feature} ${gameOrigin}`);
}

function assertNetworkOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !/^(https?|wss?):$/.test(parsed.protocol)) {
    throw new TypeError(`Expected an exact http(s)/ws(s) origin, received: ${origin}`);
  }
}
