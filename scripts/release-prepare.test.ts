// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT,
  apiVersion,
  cargoVersion,
  parseVersion,
  setCargoVersion,
  setJsonVersion,
  syncApiSnapshot,
} from "./release-prepare.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(wit: Record<string, string>, snapshot: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "release-prepare-"));
  dirs.push(root);
  for (const [dir, files] of [
    ["wit", wit],
    [SNAPSHOT, snapshot],
  ] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
  }
  return root;
}
const pkg = (version: string) => `package openidea:plugin@${version};\n`;

describe("versions", () => {
  it("accepts x.y.z with or without a leading v", () => {
    expect(parseVersion("0.1.38")).toBe("0.1.38");
    expect(parseVersion("v0.1.38")).toBe("0.1.38");
    expect(() => parseVersion("0.1")).toThrow();
    expect(() => parseVersion(undefined)).toThrow();
  });

  it("changes only the workspace version in Cargo.toml", () => {
    const toml = [
      "[workspace]",
      'members = ["crates/*"]',
      "",
      "[workspace.package]",
      'authors = ["a"]',
      'version = "0.1.37"',
      'edition = "2024"',
      "",
      "[workspace.dependencies]",
      'foo = { version = "0.1.37" }',
      "",
    ].join("\n");
    expect(cargoVersion(toml)).toBe("0.1.37");
    const next = setCargoVersion(toml, "0.1.38");
    expect(cargoVersion(next)).toBe("0.1.38");
    expect(next).toContain('foo = { version = "0.1.37" }');
    expect(next.split("\n")).toHaveLength(toml.split("\n").length);
  });

  it("keeps a JSON file's formatting", () => {
    const json = '{\n  "name": "openidea",\n  "version": "0.1.37",\n  "private": true\n}\n';
    expect(setJsonVersion(json, "0.1.38")).toBe(json.replace("0.1.37", "0.1.38"));
  });
});

describe("plugin API snapshot", () => {
  it("copies wit/ over the snapshot when the API version moved, dropping stale files", () => {
    const root = repo(
      { "plugin.wit": pkg("1.2.0"), "indexing.wit": pkg("1.2.0") },
      { "plugin.wit": pkg("1.1.0"), "old.wit": pkg("1.1.0"), "README.md": "kept" },
    );
    expect(syncApiSnapshot(root)).toEqual({ from: "1.1.0", to: "1.2.0", copied: true });
    expect(readdirSync(join(root, SNAPSHOT)).sort()).toEqual(["README.md", "indexing.wit", "plugin.wit"]);
    expect(apiVersion(readFileSync(join(root, SNAPSHOT, "plugin.wit"), "utf8"))).toBe("1.2.0");
  });

  it("leaves the snapshot alone when the API is unchanged", () => {
    const root = repo({ "plugin.wit": pkg("1.1.0") + "// edited\n" }, { "plugin.wit": pkg("1.1.0") });
    expect(syncApiSnapshot(root)).toEqual({ from: "1.1.0", to: "1.1.0", copied: false });
    expect(readFileSync(join(root, SNAPSHOT, "plugin.wit"), "utf8")).toBe(pkg("1.1.0"));
  });
});
