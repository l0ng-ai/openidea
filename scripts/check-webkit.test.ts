// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkBuild, checkSource } from "./check-webkit.ts";

it.each([
  "Promise.withResolvers()",
  "Object.groupBy(items, key)",
  "Array.fromAsync(items)",
  "text.toWellFormed()",
  'new RegExp("[a-z]", "v")',
  'RegExp("(?<=a)b")',
  "/[a-z]/v",
  "/(?<!a)b/",
  'import data from "./data.json" with { type: "json" }',
])("rejects %s in the Safari 16 startup graph", (source) => {
  expect(checkSource(source, true).length).toBeGreaterThan(0);
});

it("does not mistake regex detection strings or named groups for newer syntax", () => {
  expect(checkSource('const message = "(?<=a)"; const regex = /(?<name>a)/u;', true)).toEqual([]);
  expect(checkSource("const regex = /(\\(\\?<=)|(\\(\\?<!)/;", true)).toEqual([]);
});

it("checks the entry's static imports and all lazy chunks for syntax", () => {
  const dir = mkdtempSync(join(tmpdir(), "openidea-webkit-"));
  try {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script type="module" src="/assets/entry.js"></script>');
    writeFileSync(join(dir, "boot.js"), "");
    writeFileSync(join(dir, "assets/entry.js"), 'import "./dependency.js"; import("./lazy.js");');
    writeFileSync(join(dir, "assets/dependency.js"), "Promise.withResolvers();");
    writeFileSync(join(dir, "assets/lazy.js"), "Object.groupBy(items, key); const re = /[a-z]/v;");
    expect(checkBuild(dir)).toEqual([
      "assets/dependency.js: Promise.withResolvers requires newer WebKit",
      "assets/lazy.js: RegExp v flag requires Safari 17",
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
