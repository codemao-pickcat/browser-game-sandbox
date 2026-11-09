// Runs inside the sandboxed game iframe. Tries to create nested browsing
// contexts through every vector a game author can reach, and records whether
// each one loads, whether script inside it runs, and which directives blocked
// it. Probes run sequentially so CSP violations can be attributed per vector.
(() => {
  const HOST = window.__HOST_ORIGIN;
  const results = { host: HOST, vectors: {}, done: false };
  window.__probes = results;

  const randomId = (label) => `${label}-${Math.random().toString(36).slice(2, 8)}`;
  const nestedUrl = (id) =>
    `/nested.html?id=${encodeURIComponent(id)}&host=${encodeURIComponent(HOST)}`;

  const nestedDoc = (id) =>
    `<!doctype html><html><body>
<script>window.__inlineRan = true;</script>
<script src="/probe.js?id=${encodeURIComponent(id)}&host=${encodeURIComponent(HOST)}"></script>
</body></html>`;

  const addFrame = (attributes, html) => {
    const frame = document.createElement("iframe");
    for (const [name, value] of Object.entries(attributes || {})) {
      frame.setAttribute(name, value);
    }
    // No sandbox attribute on purpose: the point is to check inherited flags.
    if (typeof html === "string") frame.srcdoc = html;
    document.body.appendChild(frame);
    return frame;
  };

  const probe = (label, setup, timeoutMs) =>
    new Promise((resolve) => {
      const id = randomId(label);
      const record = {
        label,
        id,
        loaded: false,
        scriptRan: false,
        inlineRan: null,
        error: null,
        nested: null,
        violations: [],
      };
      results.vectors[label] = record;

      let settled = false;
      let settleTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        document.removeEventListener("securitypolicyviolation", onViolation);
        window.removeEventListener("message", onMessage);
        resolve(record);
      };
      const onViolation = (event) => {
        record.violations.push({
          directive: event.violatedDirective,
          blockedURI: event.blockedURI,
        });
        // A violated frame-src/object-src means the vector is dead; no need to
        // wait for the full timeout.
        if (event.violatedDirective === "frame-src" || event.violatedDirective === "object-src") {
          settleTimer = setTimeout(finish, 150);
        }
      };
      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.__probe !== id) return;
        record.scriptRan = true;
        record.inlineRan = data.inlineRan;
        record.nested = data;
        // Give delayed fetch/beacon reports a moment, then stop.
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, 750);
      };
      document.addEventListener("securitypolicyviolation", onViolation);
      window.addEventListener("message", onMessage);
      settleTimer = setTimeout(finish, timeoutMs);

      let frame;
      try {
        frame = setup(id);
      } catch (error) {
        record.error = String(error);
        finish();
        return;
      }
      if (frame) {
        frame.addEventListener("load", () => {
          record.loaded = true;
        });
        frame.addEventListener("error", () => {
          record.error = "iframe error event";
        });
      }
    });

  const specs = [
    ["iframe-src-same-origin", (id) => addFrame({ src: nestedUrl(id) }), 500],

    ["iframe-srcdoc", (id) => addFrame({}, nestedDoc(id)), 1400],

    [
      "iframe-blob",
      (id) => {
        const url = URL.createObjectURL(new Blob([nestedDoc(id)], { type: "text/html" }));
        return addFrame({ src: url });
      },
      500,
    ],

    [
      "iframe-data",
      (id) => addFrame({ src: `data:text/html,${encodeURIComponent(nestedDoc(id))}` }),
      500,
    ],

    [
      "iframe-javascript-url",
      (id) =>
        addFrame({
          src: `javascript:parent.postMessage({__probe:${JSON.stringify(id)}},'*');`,
        }),
      500,
    ],

    [
      "iframe-about-blank-write",
      (id) => {
        const frame = addFrame({});
        const doc = frame.contentDocument;
        if (!doc) throw new Error("contentDocument unavailable");
        doc.open();
        doc.write(nestedDoc(id));
        doc.close();
        return frame;
      },
      1400,
    ],

    [
      "iframe-blank-then-navigate",
      (id) => {
        const frame = addFrame({});
        frame.contentWindow.location.href = nestedUrl(id);
        return frame;
      },
      600,
    ],

    // A nested frame that tries to grant itself more than the parent allows.
    [
      "iframe-sandbox-elevate",
      (id) =>
        addFrame(
          {
            sandbox:
              "allow-scripts allow-same-origin allow-top-navigation allow-popups " +
              "allow-forms allow-modals allow-downloads",
          },
          nestedDoc(id),
        ),
      1400,
    ],

    [
      "object-data",
      (id) => {
        const element = document.createElement("object");
        element.type = "text/html";
        element.data = nestedUrl(id);
        document.body.appendChild(element);
        return element;
      },
      600,
    ],

    [
      "embed-src",
      (id) => {
        const element = document.createElement("embed");
        element.type = "text/html";
        element.src = nestedUrl(id);
        document.body.appendChild(element);
        return element;
      },
      600,
    ],

    [
      "window-open",
      (id) => {
        const opened = window.open(nestedUrl(id));
        results.vectors["window-open"].opened = opened !== null;
        if (opened) opened.close();
        return null;
      },
      300,
    ],

    [
      "fenced-frame-src",
      (id) => {
        const frame = document.createElement("fencedframe");
        frame.setAttribute("src", nestedUrl(id));
        document.body.appendChild(frame);
        return frame;
      },
      600,
    ],
  ];

  (async () => {
    // Direct action from the game document itself, for comparison.
    try {
      top.location.href = `${HOST}/egress?via=game-topnav`;
      results.gameTopNav = "assigned";
    } catch (error) {
      results.gameTopNav = `blocked:${error && error.name}`;
    }

    for (const [label, setup, timeoutMs] of specs) {
      await probe(label, setup, timeoutMs);
    }
    results.done = true;
  })();
})();
