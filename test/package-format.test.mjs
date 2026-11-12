import assert from "node:assert/strict";
import test from "node:test";
import { resolvePackageReference, resourceMime } from "../dist/package-format.js";

const parents = ["..", "%2e%2e", "%2E%2E", "%2e%2E", ".%2e", "%2E."];
const bases = ["index.html", "one/main.js", "one/two/main.js", "资料/entry.js"];

test("encoded parent traversal cannot be clamped back onto the virtual package root", () => {
  assert.throws(() => resolvePackageReference("%2e%2e/secret.js", "index.html"), error => error.code === "INVALID_PATH");
});

test("literal, encoded and mixed-case dots reject every over-root step before URL clamping", () => {
  for (const from of bases) for (const parent of parents) {
    const depth = from.split("/").length - 1;
    for (const reference of [
      `${parent}/`.repeat(depth + 1) + "secret.js?query=%2f#view",
      `/${parent}/secret.js`,
      `/dir/${parent}/${parent}/secret.js`,
      "../".repeat(depth) + `${parent}/secret.js`,
    ]) assert.throws(() => resolvePackageReference(reference, from), error => error.code === "INVALID_PATH", `${from}: ${reference}`);
  }
});

test("encoded dot steps within the root resolve exactly like their literal equivalents", () => {
  for (const from of bases) for (const parent of parents) {
    const depth = from.split("/").length - 1;
    const pairs = [
      [`child/${parent}/secret.js`, "child/../secret.js"],
      [`/child/${parent}/secret.js`, "/child/../secret.js"],
      [`${parent}/`.repeat(depth) + "secret.js", "../".repeat(depth) + "secret.js"],
      ["%2E/secret.js", "./secret.js"],
      ["secret%2Ejs", "secret.js"],
      ["%73ecret%2Ejs", "secret.js"],
      ["%2e%2e%2e/secret.js", ".../secret.js"],
      ["%2e%2efoo/secret.js", "..foo/secret.js"],
    ];
    for (const [encoded, literal] of pairs) assert.deepEqual(resolvePackageReference(encoded + "?v=1#view?keep=2", from), resolvePackageReference(literal + "?v=1#view?keep=2", from), `${from}: ${encoded}`);
  }
});

test("encoded separators, double encoding and invalid segments cannot disappear through normalization", () => {
  const invalid = [
    "a%2fb.js", "a%2Fb.js", "a%5cb.js", "a%5Cb.js", "%2Fsecret.js", "%5csecret.js",
    "%2e%2e%2fsecret.js", "%2e%2e%5csecret.js", "a%2fb/../secret.js", "a%5Cb/../secret.js",
    "%252e%252e/secret.js", ".%252e/secret.js", "%252e./secret.js", "%252fsecret.js", "a%255cb.js",
    "%252e%252e/../secret.js", "a%252fb/../secret.js", "%25252e%25252e/secret.js",
    "bad%/secret.js", "bad%GG/secret.js", "bad%GG/../secret.js", "%C0%AE%C0%AE/secret.js",
    "%E0%80%AE/secret.js", "%ED%A0%80/secret.js", "bad%00/../secret.js", "bad%20/../secret.js",
    "bad%23/../secret.js", "bad%3f/../secret.js", "bad%3a/../secret.js",
  ];
  for (const from of bases) for (const reference of invalid) {
    assert.throws(() => resolvePackageReference(reference, from), error => error.code === "INVALID_PATH", `${from}: ${reference}`);
    assert.throws(() => resolvePackageReference("/" + reference, from), error => error.code === "INVALID_PATH", `${from}: /${reference}`);
  }
});

test("ordinary Unicode encoding, in-root parents and virtual query/hash semantics remain supported", () => {
  const suffix = "?next=%2f%5c%252e#view?x=%2F";
  assert.deepEqual(resolvePackageReference("../%E8%B5%84%E4%BA%A7/%E5%9B%BE%E7%89%87%2epng" + suffix, "scripts/main.js"), {path:"资产/图片.png",suffix});
  assert.deepEqual(resolvePackageReference("../资产/图片.png" + suffix, "scripts/main.js"), {path:"资产/图片.png",suffix});
  assert.deepEqual(resolvePackageReference("%2E%2E/图片.png", "资料/entry.js"), {path:"图片.png",suffix:""});
  assert.deepEqual(resolvePackageReference("/one/%2e%2e/secret.js", "deep/nested/main.js"), {path:"secret.js",suffix:""});
  assert.deepEqual(resolvePackageReference("?v=1#view", "one/main.js"), {path:"one/main.js",suffix:"?v=1#view"});
  assert.deepEqual(resolvePackageReference("#view?mode=1", "one/main.js"), {path:"one/main.js",suffix:"#view?mode=1"});
});

test("MIME lookup rejects inherited keys and preserves known case-insensitive types", () => {
  for(const path of ["payload.constructor","payload.CONSTRUCTOR","payload.__proto__"]){
    assert.throws(()=>resourceMime(path),error=>error.code==="UNSUPPORTED_FORMAT");
  }
  for(const [path,mime] of [["index.HTML","text/html"],["main.MJS","text/javascript"],["image.PNG","image/png"],["view.SVG","image/svg+xml"],["font.WOFF2","font/woff2"],["data.TXT","text/plain"]]){
    assert.equal(resourceMime(path),mime);
  }
});

test("absolute/network URLs remain forbidden and base paths must be canonical", () => {
  for (const url of ["https://other.invalid/%2e%2e/secret.js", "https://package.invalid/%2e%2e/secret.js", "//package.invalid/%2e%2e/secret.js"]) {
    assert.throws(() => resolvePackageReference(url, "deep/nested/main.js"), error => error.code === "EXTERNAL_URL");
  }
  for (const from of ["../main.js", "/main.js", "a/./main.js", "a%2fb/main.js"]) {
    assert.throws(() => resolvePackageReference("secret.js", from), error => error.code === "INVALID_PATH");
  }
});
