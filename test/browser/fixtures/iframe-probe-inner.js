// Runs inside a nested browsing context created by the game. Reports what the
// nested document is allowed to do, so we can tell whether iframe nesting
// preserved the CSP and the inherited sandbox flags.
(() => {
  const script = document.currentScript;
  const params = new URL(script.src).searchParams;
  const ID = window.__PROBE_ID || params.get("id") || "unknown";
  const HOST = window.__PROBE_HOST || params.get("host") || "";

  const out = {
    __probe: ID,
    inlineRan: Boolean(window.__inlineRan),
    origin: location.origin,
    href: location.href,
  };
  const violations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
  });

  const capture = (name, fn) => {
    try {
      out[name] = fn();
    } catch (error) {
      out[name] = `blocked:${error && error.name}`;
    }
  };

  const tag = encodeURIComponent(ID);
  capture("readParent", () => Boolean(parent.document.body));
  capture("readTop", () => Boolean(top.document.body));
  capture("frameElement", () => (window.frameElement ? "exposed" : "null"));
  capture("eval", () => (eval("1+1") === 2 ? "allowed" : "denied"));
  capture("popup", () => (window.open("about:blank") ? "opened" : "blocked"));
  capture("topNav", () => {
    top.location.href = `${HOST}/egress?via=topnav-${tag}`;
    return "assigned";
  });
  capture("formSubmit", () => {
    const form = document.createElement("form");
    form.action = `${HOST}/egress?via=form-${tag}`;
    form.method = "get";
    document.body.appendChild(form);
    form.submit();
    return "submitted";
  });
  capture("imgBeacon", () => {
    const image = new Image();
    image.src = `${HOST}/egress?via=img-${tag}`;
    document.body.appendChild(image);
    return "requested";
  });
  capture("websocket", () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onerror = () => {};
    return "attempted";
  });
  capture("nestedIframe", () => {
    const frame = document.createElement("iframe");
    frame.src = `${HOST}/nested.html`;
    document.body.appendChild(frame);
    return "created";
  });

  fetch(`${HOST}/egress?via=fetch-${tag}`, { mode: "no-cors" })
    .then(() => {
      out.fetch = "sent";
    })
    .catch((error) => {
      out.fetch = `blocked:${error && error.name}`;
    });

  const send = () => parent.postMessage({ ...out, violations }, "*");
  send();
  setTimeout(send, 700);
})();
