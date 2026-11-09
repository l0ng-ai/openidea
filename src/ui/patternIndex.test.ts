import { describe, expect, it } from "vitest";
import { createPatternIndex, extensionKeys, firstCharKeys } from "./patternIndex";

describe("pattern index keys", () => {
  it("derives the extensions a pattern can end with", () => {
    expect(extensionKeys("\\.ya?ml$")?.sort()).toEqual(["yaml", "yml"]);
    expect(extensionKeys(".*\\.(es|edql)$")?.sort()).toEqual(["edql", "es"]);
    expect(extensionKeys("\\.[cm]?js$")?.sort()).toEqual(["cjs", "js", "mjs"]);
    expect(extensionKeys("\\.(tar\\.gz|tgz)$")?.sort()).toEqual(["gz", "tgz"]);
    expect(extensionKeys("^Cargo\\.toml$")).toEqual(["toml"]);
    expect(extensionKeys("/(tests?)/.*\\.java$")).toEqual(["java"]);
    expect(extensionKeys("\\.js")).toBeNull();
    expect(extensionKeys("\\.(md|[a-z]+)$")).toBeNull();
    expect(extensionKeys("a\\.md$|b\\.txt$")).toBeNull();
    expect(extensionKeys("(architecture)(\\.(md|txt))?$")).toBeNull();
  });

  it("derives the characters an anchored pattern can start with", () => {
    expect(firstCharKeys("^README")).toEqual(["R"]);
    expect(firstCharKeys("^(README|readme)(\\.md)?$")?.sort()).toEqual(["R", "r"]);
    expect(firstCharKeys("^[Mm]akefile$")?.sort()).toEqual(["M", "m"]);
    expect(firstCharKeys("^\\.babelrc$")).toEqual(["."]);
    expect(firstCharKeys("^\\.?kitchen")).toBeNull();
    expect(firstCharKeys("README")).toBeNull();
    expect(firstCharKeys("^a|b")).toBeNull();
  });
});

describe("pattern index", () => {
  const patterns = [
    "^README",
    "\\.ya?ml$",
    "(main|ci)\\.ya?ml$",
    "\\.md$",
    "^\\.github",
    "/tests?/.*\\.java$",
    "\\.java$",
    "^(a|b)",
    "x",
    "^cargo\\.toml$",
    "\\.TXT$",
  ].map((source, order) => ({
    re: new RegExp(source, source.includes("cargo") || source.includes("TXT") ? "i" : ""),
    source,
    path: source.startsWith("/"),
    order,
  }));

  const linear = (name: string, path: string | null) =>
    patterns.find((p) => {
      const subject = p.path ? path : name;
      return subject !== null && p.re.test(subject);
    })?.order;

  it("finds the same first match as a linear scan", () => {
    const index = createPatternIndex(patterns);
    const names = [
      "README.md",
      "ci.yml",
      "a.yaml",
      "x.md",
      ".github",
      "Foo.java",
      "b.txt",
      "box",
      "nothing.rs",
      "md",
      "Cargo.toml",
      "NOTES.txt",
    ];
    for (const name of names) {
      for (const path of [null, `/p/tests/${name}`, `/p/src/${name}`]) {
        expect(index.find(name, path)?.order, `${name} ${path}`).toBe(linear(name, path));
      }
    }
  });
});
