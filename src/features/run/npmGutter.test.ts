import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { scriptConfigFor, scriptConfigIds, scriptEntries } from "./npmGutter";

function cfg(over: Partial<RunConfig>): RunConfig {
  return {
    id: "x",
    name: "x",
    kind: "npm",
    command: "npm",
    args: [],
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
    ...over,
  };
}

describe("scriptEntries", () => {
  it("lists scripts with their lines in document order", () => {
    const text = [
      "{",
      '  "name": "app",',
      '  "scripts": {',
      '    "dev": "vite",',
      '    "build": "tsc && vite build",',
      '    "test": "vitest run"',
      "  }",
      "}",
    ].join("\n");
    expect(scriptEntries(text)).toEqual([
      { name: "dev", line: 3 },
      { name: "build", line: 4 },
      { name: "test", line: 5 },
    ]);
  });

  it("parses names with escapes and values containing braces or colons", () => {
    const text = [
      "{",
      '  "scripts": {',
      '    "say \\"hi\\"": "echo \\"{\\" done",',
      '    "a\\u0041b": "node -e \\"x:{y}\\""',
      "  }",
      "}",
    ].join("\n");
    expect(scriptEntries(text).map((e) => e.name)).toEqual(['say "hi"', "aAb"]);
    expect(scriptEntries(text).map((e) => e.line)).toEqual([2, 3]);
  });

  it("ignores scripts nested in other objects", () => {
    const text = [
      "{",
      '  "a": {',
      '    "scripts": {',
      '      "inner": "x"',
      "    }",
      "  },",
      '  "scripts": {',
      '    "outer": "y"',
      "  }",
      "}",
    ].join("\n");
    expect(scriptEntries(text)).toEqual([{ name: "outer", line: 7 }]);
  });

  it("tracks lines through object, array and scalar values", () => {
    const text = [
      "{",
      '  "scripts": {',
      '    "a": 1,',
      '    "b": true,',
      '    "c": null,',
      '    "d": [1, 2],',
      '    "e": { "x": 1 },',
      '    "f": "ok"',
      "  }",
      "}",
    ].join("\n");
    expect(scriptEntries(text).map((e) => e.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(scriptEntries(text).map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("returns nothing without a scripts key", () => {
    expect(scriptEntries('{\n  "name": "x"\n}\n')).toEqual([]);
  });

  it("returns an empty scripts object as no entries", () => {
    expect(scriptEntries('{\n  "scripts": {}\n}\n')).toEqual([]);
  });

  it("ignores a scripts value that is not an object", () => {
    expect(scriptEntries('{\n  "scripts": "dev"\n}\n')).toEqual([]);
  });

  it("keeps entries parsed before malformed text", () => {
    const text = ["{", '  "scripts": {', '    "a": "x",', '    "b": '].join("\n");
    expect(scriptEntries(text)).toEqual([{ name: "a", line: 2 }]);
  });

  it("tolerates a trailing comma", () => {
    expect(scriptEntries('{\n  "scripts": {\n    "a": "x",\n  },\n}\n')).toEqual([{ name: "a", line: 2 }]);
  });

  it("skips a BOM", () => {
    expect(scriptEntries('﻿{\n  "scripts": {\n    "dev": "vite"\n  }\n}\n')).toEqual([{ name: "dev", line: 2 }]);
  });
});

describe("scriptConfigFor", () => {
  const root = cfg({ id: "npm:dev", name: "pnpm run dev", command: "pnpm", args: ["run", "dev"], cwd: null });

  it("matches the root package's detected id", () => {
    expect(scriptConfigFor([root], "dev", "", null)).toBe(root);
  });

  it("matches a workspace member by its package name or directory", () => {
    const web = cfg({
      id: "npm:web:dev",
      name: "web: pnpm run dev",
      command: "pnpm",
      args: ["run", "dev"],
      cwd: "web",
    });
    expect(scriptConfigFor([web], "dev", "web", "web")).toBe(web);
    expect(scriptConfigFor([web], "dev", "web", null)).toBe(web);
  });

  it("falls back to npm run args in the same directory", () => {
    const custom = cfg({ id: "user-cfg", name: "my dev", args: ["run", "dev"], cwd: "./web/" });
    expect(scriptConfigFor([custom], "dev", "web", null)).toBe(custom);
  });

  it("prefers an id match over an args match", () => {
    const byArgs = cfg({ id: "user-cfg", args: ["run", "dev"], cwd: null });
    expect(scriptConfigFor([byArgs, root], "dev", "", null)).toBe(root);
  });

  it("finds nothing in another directory", () => {
    expect(scriptConfigFor([root], "dev", "web", null)).toBeUndefined();
  });

  it("derives the backend configuration ids", () => {
    expect(scriptConfigIds("dev", null, "")).toEqual(["npm:dev"]);
    expect(scriptConfigIds("dev", "web", "packages/web")).toEqual(["npm:dev", "npm:web:dev"]);
  });
});
