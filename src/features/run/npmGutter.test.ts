import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  npmGutter,
  scriptConfigFor,
  scriptConfigIds,
  scriptEntries,
  scriptMenuItems,
  scriptPackageManager,
} from "./npmGutter";
import * as ui from "@/ui";
import * as store from "./store";

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

  it("tracks CRLF lines after non-ASCII and astral characters", () => {
    const text = [
      "{",
      '  "description": "中文 🚀 café",',
      '  "scripts": {',
      '    "构建🚀": "echo 完成",',
      '    "test": "echo ok"',
      "  }",
      "}",
    ].join("\r\n");
    expect(scriptEntries(text)).toEqual([
      { name: "构建🚀", line: 3 },
      { name: "test", line: 4 },
    ]);
  });

  it("decodes escaped unicode and backslashes in keys and values", () => {
    const text = String.raw`{"scripts":{"\u6784\u5efa\ud83d\ude80":"echo \"ok\" \\path","say\\hi":"echo ok"}}`;
    expect(scriptEntries(text)).toEqual([
      { name: "构建🚀", line: 0 },
      { name: "say\\hi", line: 0 },
    ]);
  });

  it("produces no entries for scripts nested in an object or array", () => {
    expect(scriptEntries('{"config":{"scripts":{"nested":"echo no"}}}')).toEqual([]);
    expect(scriptEntries('{"config":[{"scripts":{"nested":"echo no"}}]}')).toEqual([]);
  });

  it("skips long numeric metadata before scripts", () => {
    expect(scriptEntries('{"metadata":1234567890123456,"scripts":{"dev":"echo ok"}}')).toEqual([
      { name: "dev", line: 0 },
    ]);
  });
});

describe("scriptPackageManager", () => {
  it.each(["npm", "pnpm", "yarn", "bun"])("prefers the declared %s over lockfiles", (pm) => {
    expect(scriptPackageManager({ packageManager: `${pm}@1.0.0` }, ["pnpm-lock.yaml", "yarn.lock", "bun.lock"])).toBe(
      pm,
    );
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ])("uses %s when no manager is declared", (file, pm) => {
    expect(scriptPackageManager({}, [file])).toBe(pm);
    expect(scriptPackageManager({ packageManager: "unknown@1" }, [file])).toBe(pm);
  });

  it("uses backend lockfile precedence and defaults to npm", () => {
    expect(scriptPackageManager(null, ["bun.lock", "yarn.lock", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(scriptPackageManager(null, ["bun.lock", "yarn.lock"])).toBe("yarn");
    expect(scriptPackageManager(null, [])).toBe("npm");
  });
});

describe("scriptMenuItems", () => {
  beforeEach(() => {
    vi.spyOn(store, "loadConfigs").mockResolvedValue();
    useProject.setState({ project: { root: "/project" } as never });
    store.useRun.setState({ configs: [] });
    vi.spyOn(commands, "fsReadDir").mockResolvedValue({
      status: "ok",
      data: [{ name: "pnpm-lock.yaml", path: "/project/pnpm-lock.yaml", kind: "file" } as never],
    });
    vi.spyOn(commands, "fsReadText").mockRejectedValue(new Error("not found"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useProject.setState({ project: null });
    store.useRun.setState({ configs: [] });
  });

  it("uses the package lockfile for an undetected script", async () => {
    const items = await scriptMenuItems({ name: "new", line: 0 }, "/project/package.json", "{}");
    expect(items).toMatchObject([{ label: "Run 'pnpm run new'" }, { label: "Debug 'pnpm run new'" }]);
    expect(commands.fsReadDir).toHaveBeenCalledWith("/project/");
  });

  it("inherits the backend's workspace manager from a sibling script", async () => {
    store.useRun.setState({ configs: [cfg({ command: "yarn", cwd: "packages/web" })] });
    const items = await scriptMenuItems(
      { name: "new", line: 0 },
      "/project/packages/web/package.json",
      '{"packageManager":"pnpm@9"}',
    );
    expect(items).toMatchObject([{ label: "Run 'yarn run new'" }, { label: "Debug 'yarn run new'" }]);
    expect(commands.fsReadDir).not.toHaveBeenCalled();
  });

  it("does not inherit an unrelated package's manager or a custom executable", async () => {
    store.useRun.setState({
      configs: [cfg({ command: "yarn", cwd: "other" }), cfg({ command: "echo", cwd: null })],
    });
    const items = await scriptMenuItems({ name: "new", line: 0 }, "/project/package.json", "{}");
    expect(items).toMatchObject([{ label: "Run 'pnpm run new'" }, { label: "Debug 'pnpm run new'" }]);
  });

  it("uses root detection for a workspace member's first script", async () => {
    vi.mocked(commands.fsReadText).mockResolvedValue({ status: "ok", data: '{"packageManager":"yarn@4"}' });
    const items = await scriptMenuItems({ name: "new", line: 0 }, "/project/packages/web/package.json", "{}");
    expect(items).toMatchObject([{ label: "Run 'yarn run new'" }, { label: "Debug 'yarn run new'" }]);
    expect(commands.fsReadDir).toHaveBeenCalledWith("/project/");
  });

  it("uses local detection for a polyglot package without a root manifest", async () => {
    const items = await scriptMenuItems({ name: "new", line: 0 }, "/project/web/package.json", "{}");
    expect(items).toMatchObject([{ label: "Run 'pnpm run new'" }, { label: "Debug 'pnpm run new'" }]);
    expect(commands.fsReadDir).toHaveBeenCalledWith("/project/web/");
  });

  it("preserves a matching user configuration", async () => {
    store.useRun.setState({ configs: [cfg({ id: "npm:new", name: "Custom new", command: "custom" })] });
    const items = await scriptMenuItems({ name: "new", line: 0 }, "/project/package.json", "{}");
    expect(items).toMatchObject([{ label: "Run 'Custom new'" }, { label: "Debug 'Custom new'" }]);
    expect(commands.fsReadDir).not.toHaveBeenCalled();
  });

  it("renders a native button and opens its menu on keyboard-style activation after Unicode text", async () => {
    const show = vi.spyOn(ui, "showContextMenu").mockImplementation(() => {});
    const text = '{\r\n  "description": "中文 🚀",\r\n  "scripts": {\r\n    "dev": "echo ok"\r\n  }\r\n}';
    const view = new EditorView({
      doc: text,
      parent: document.body,
      extensions: npmGutter({ doc: 1, path: "/project/package.json", language: "json", uiMode: null, readOnly: false }),
    });
    try {
      await vi.waitFor(() => expect(view.dom.querySelector("button[aria-label=\"Run 'dev'\"]")).not.toBeNull());
      expect(view.state.doc.line(4).from).toBe(text.replaceAll("\r\n", "\n").indexOf('    "dev"'));
      view.dom.querySelector<HTMLButtonElement>("button[aria-label=\"Run 'dev'\"]")!.click();
      await vi.waitFor(() =>
        expect(show).toHaveBeenCalledWith(expect.anything(), [
          expect.objectContaining({ label: "Run 'pnpm run dev'" }),
          expect.objectContaining({ label: "Debug 'pnpm run dev'" }),
        ]),
      );
    } finally {
      view.destroy();
    }
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

  it("matches an unnamed nested member's overridden config by its full relative directory", () => {
    const custom = cfg({ id: "npm:packages/web:dev", command: "custom", cwd: "packages/web" });
    expect(scriptConfigFor([custom], "dev", "packages/web", null)).toBe(custom);
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
    expect(scriptConfigIds("dev", "web", "packages/web")).toEqual(["npm:dev", "npm:web:dev", "npm:packages/web:dev"]);
  });
});
