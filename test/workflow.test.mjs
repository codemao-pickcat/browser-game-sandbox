import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflows = new Map(["ci", "publish"].map(name => [
  name, readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
]));

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

function bashPath(path) {
  return process.platform === "win32"
    ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : path;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function linesIn(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

function runInstaller(t, source, failures) {
  const directory = tempDirectory(t);
  const attempts = join(directory, "attempts");
  const timeoutArgs = join(directory, "timeout-args");
  const npxArgs = join(directory, "npx-args");
  const delays = join(directory, "delays");
  writeFileSync(attempts, "0");
  const commands = {
    timeout: 'printf "%s\\n" "$*" >> "$TIMEOUT_ARGS"\nshift 2\nexec "$@"',
    npx: 'count=$(<"$ATTEMPTS_FILE")\ncount=$((count + 1))\nprintf "%s" "$count" > "$ATTEMPTS_FILE"\nprintf "%s\\n" "$*" >> "$NPX_ARGS"\nif (( count <= FAILURES )); then exit 7; fi',
    sleep: 'printf "%s\\n" "$*" >> "$DELAYS"',
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(directory, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  const result = spawnSync("bash", ["-c", [
    `export PATH=${shellQuote(bashPath(directory))}:"$PATH"`,
    stepScript(source, "Install Chromium"),
  ].join("\n")], {
    encoding: "utf8", timeout: 10_000,
    env: {
      ...process.env, FAILURES: String(failures), ATTEMPTS_FILE: bashPath(attempts),
      TIMEOUT_ARGS: bashPath(timeoutArgs), NPX_ARGS: bashPath(npxArgs), DELAYS: bashPath(delays),
    },
  });
  assert.ifError(result.error);
  return {
    ...result, attempts: Number(readFileSync(attempts, "utf8")),
    timeoutArgs: linesIn(timeoutArgs), npxArgs: linesIn(npxArgs), delays: linesIn(delays),
  };
}

for (const [name, source] of workflows) {
  test(`${name} Chromium installation stops after the first success`, (t) => {
    const result = runInstaller(t, source, 0);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.delays, []);
    assert.deepEqual(result.npxArgs, ["playwright install --with-deps chromium"]);
    assert.deepEqual(result.timeoutArgs, ["--kill-after=10s 180s npx playwright install --with-deps chromium"]);
  });

  test(`${name} Chromium installation retries transient failures`, (t) => {
    const result = runInstaller(t, source, 2);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.delays, ["10", "10"]);
    assert.equal(result.timeoutArgs.length, 3);
    assert.equal(result.npxArgs.length, 3);
  });

  test(`${name} Chromium installation fails closed after three failures`, (t) => {
    const result = runInstaller(t, source, 10);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.delays, ["10", "10"]);
    assert.match(result.stdout, /::error::Chromium installation failed after 3 attempts/);
  });
}

test("CI and publish use the same bounded installer and a stable runner", () => {
  assert.equal(stepScript(workflows.get("ci"), "Install Chromium"), stepScript(workflows.get("publish"), "Install Chromium"));
  for (const source of workflows.values()) {
    assert.doesNotMatch(source, /ubuntu-latest|continue-on-error/);
    assert.match(source, /runs-on: ubuntu-24\.04/);
    assert.match(source, /timeout-minutes:/);
  }
  const publish = workflows.get("publish");
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
