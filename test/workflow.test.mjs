import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflows = new Map(["ci", "publish"].map(name => [
  name, readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
]));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const playwrightVersion = lock.packages["node_modules/@playwright/test"].version;

function stepScript(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("      - name:"));
  const step = lines.slice(start, next === -1 ? undefined : next);
  const run = step.findIndex(line => line === "        run: |");
  assert.notEqual(run, -1, `Expected a Bash block for ${name}`);
  return step.slice(run + 1).filter(line => line.startsWith("          "))
    .map(line => line.slice(10)).join("\n");
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "sandbox-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runBrowserCheck(t, source, { version = playwrightVersion, broken = false } = {}) {
  const directory = tempDirectory(t);
  const packageDirectory = join(directory, "node_modules", "@playwright", "test");
  const closed = join(directory, "browser-closed");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
    name: "@playwright/test", version, type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  }));
  writeFileSync(join(packageDirectory, "index.js"), `
    import { writeFileSync } from "node:fs";
    export const chromium = {
      async launch() {
        if (process.env.BROKEN_BROWSER === "true") throw new Error("Browser unavailable");
        return {
          version: () => "fixture-chromium",
          close: async () => writeFileSync(process.env.BROWSER_CLOSED, "closed"),
        };
      },
    };
  `);
  const result = spawnSync("bash", ["-c", stepScript(source, "Verify browser environment")], {
    cwd: directory, encoding: "utf8", timeout: 10_000,
    env: {
      ...process.env, PLAYWRIGHT_IMAGE_VERSION: playwrightVersion,
      BROKEN_BROWSER: String(broken), BROWSER_CLOSED: closed,
    },
  });
  assert.ifError(result.error);
  return { ...result, closed: existsSync(closed) };
}

for (const [name, source] of workflows) {
  test(`${name} checks the browser and closes it before running tests`, (t) => {
    const result = runBrowserCheck(t, source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.closed, true);
    assert.match(result.stdout, /Chromium fixture-chromium/);
  });

  test(`${name} rejects a Playwright/container version mismatch`, (t) => {
    const result = runBrowserCheck(t, source, { version: "0.0.0" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match container/);
    assert.equal(result.closed, false);
  });

  test(`${name} fails closed when the preinstalled browser cannot launch`, (t) => {
    const result = runBrowserCheck(t, source, { broken: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser unavailable/);
    assert.equal(result.closed, false);
  });
}

test("CI and publish use matching preinstalled browsers without apt or skipped checks", () => {
  assert.equal(stepScript(workflows.get("ci"), "Verify browser environment"), stepScript(workflows.get("publish"), "Verify browser environment"));
  for (const source of workflows.values()) {
    assert.doesNotMatch(source, /ubuntu-latest|continue-on-error|playwright install|apt-get/);
    assert.match(source, /runs-on: ubuntu-24\.04/);
    assert.match(source, /timeout-minutes:/);
    assert.match(source, /options: --ipc=host --init/);
    assert.equal(source.match(/image: mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/)[1], playwrightVersion);
    assert.equal(source.match(/PLAYWRIGHT_IMAGE_VERSION: "([\d.]+)"/)[1], playwrightVersion);
  }
  assert.match(workflows.get("ci"), /run: npm run test:browser/);
  const publish = workflows.get("publish");
  assert.match(publish, /run: npm run test:all/);
  assert.match(publish, /head_repository\.full_name == github\.repository/);
  assert.ok(publish.indexOf("- name: Validate release tag") < publish.indexOf("run: npm ci"));
});

test("publish accepts only a real version tag at the successful CI commit", (t) => {
  const directory = tempDirectory(t);
  const env = {
    ...process.env, GIT_AUTHOR_NAME: "Workflow Test", GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Workflow Test", GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const git = (...args) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "-c", `core.hooksPath=${directory}/no-hooks`,
    ...args,
  ], { cwd: directory, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("commit", "--allow-empty", "--quiet", "-m", "first");
  const sha = git("rev-parse", "HEAD");
  git("tag", "v0.2.1");
  git("tag", "-a", "v0.2.2", "-m", "annotated");
  git("branch", "v0.2.3");
  git("commit", "--allow-empty", "--quiet", "-m", "second");
  const otherSha = git("rev-parse", "HEAD");
  const verify = (tag, expectedSha) => {
    const result = spawnSync("bash", ["-c", stepScript(workflows.get("publish"), "Validate release tag")], {
      cwd: directory, env: { ...env, RELEASE_TAG: tag, EXPECTED_SHA: expectedSha },
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  };
  for (const tag of ["v0.2.1", "v0.2.2"]) assert.equal(verify(tag, sha).status, 0);
  for (const tag of ["main", "v0.2.1;echo unsafe", "v0.2.3", "v0.2.9"]) {
    assert.notEqual(verify(tag, sha).status, 0);
  }
  const mismatch = verify("v0.2.1", otherSha);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /Release tag does not match the successful CI commit/);
});
