import assert from "node:assert/strict";
import test from "node:test";
import {
  createSandboxGamePackagePolicy,
} from "../dist/index.js";

function makePolicy() {
  return createSandboxGamePackagePolicy({
    entry: "index.html",
    resources: [
      "index.html",
      "game.js",
      "styles/game.css",
      "assets/logo.png",
    ],
  });
}

test("requires index.html and validates exact whitelisted resources", () => {
  const policy = makePolicy();

  assert.equal(policy.entryPath, "/index.html");
  assert.equal(policy.isAllowedResourcePath("/index.html"), true);
  assert.equal(policy.isAllowedResourcePath("game.js"), true);
  assert.equal(policy.isAllowedResourcePath("/missing.js"), false);
  assert.equal(policy.assertAllowedResourcePath("styles/game.css"), "/styles/game.css");
  assert.equal(
    policy.assertAllowedResourceUrl("https://game.example.test/assets/logo.png", "https://game.example.test"),
    "/assets/logo.png",
  );
});

test("rejects traversal, encoded paths, query strings, and cross-origin resources", () => {
  assert.throws(
    () => createSandboxGamePackagePolicy({ entry: "index.html", resources: ["index.html", "../secret.js"] }),
    /Traversal|Invalid sandbox package resource path/,
  );

  const policy = makePolicy();
  for (const path of ["/../secret.js", "/%2e%2e/secret.js", "/game.js?cache=1", "/game.js#fragment"]) {
    assert.equal(policy.isAllowedResourcePath(path), false, path);
  }
  assert.throws(
    () => policy.assertAllowedResourceUrl("https://attacker.example.test/game.js", "https://game.example.test"),
    /game origin/,
  );
});

test("rejects an entry path other than index.html", () => {
  const policy = makePolicy();
  assert.throws(() => policy.assertEntryPath("/game.html"), /index.html/);
});
