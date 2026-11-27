import { describe, expect, it, vi } from "vitest";

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({
  docOpen: vi.fn(),
  applyWorkspaceEdit: vi.fn(),
  docSave: vi.fn(),
  docClose: vi.fn(),
  lspRestartNamed: vi.fn(),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});
vi.mock("@/workbench/messages", () => ({ confirm: async () => true }));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<object>()),
  notifications: () => ({ notify: vi.fn(), expire: vi.fn() }),
}));
const store = vi.hoisted(() => ({ status: "installed", installTool: vi.fn(async () => null) }));
vi.mock("./store", () => ({
  installTool: store.installTool,
  refreshTools: async () => {},
  toolByName: () => ({ status: store.status }),
  useTools: { getState: () => ({ loaded: true }) },
}));

const { cmkOptionsInsertion, cmkState, effectiveCmkState, enable, localExtends, stripJsonc, usesCssModules } =
  await import("./cssModules");

const insert = (text: string) => {
  const edit = cmkOptionsInsertion(text)!;
  return text.slice(0, edit.at) + edit.text + text.slice(edit.at);
};

describe("CSS Modules Kit hint", () => {
  it("reads cmkOptions from tsconfig.json with comments and trailing commas", () => {
    const tsconfig =
      '{\n  // "cmkOptions": { "enabled": true },\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}\n';
    expect(JSON.parse(stripJsonc(tsconfig))).toEqual({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
    expect(cmkState(tsconfig)).toBe("absent");
    expect(cmkState('{ /* on */ "cmkOptions": { "enabled": true } }')).toBe("enabled");
    expect(cmkState('{ "cmkOptions": { "enabled": false } }')).toBe("set");
    expect(cmkState('{ "a": "// not a comment, }" }')).toBe("absent");
    expect(cmkState("{ broken")).toBeNull();
  });

  it("inherits cmkOptions through local extends, as CSS Modules Kit does", async () => {
    const files: Record<string, string> = {
      "/p/tsconfig.base.json": '{ "cmkOptions": { "enabled": true } }',
      "/p/off.json": '{ "cmkOptions": { "enabled": false } }',
      "/p/app/tsconfig.json": '{ // app\n "extends": ["@tsconfig/strictest", "../tsconfig.base"] }',
      "/p/web/tsconfig.json": '{ "extends": "../off.json" }',
      "/p/own/tsconfig.json": '{ "extends": "../tsconfig.base.json", "cmkOptions": { "enabled": false } }',
      "/p/loop/tsconfig.json": '{ "extends": "./tsconfig.json" }',
    };
    const read = async (path: string) => files[path] ?? null;
    expect(localExtends("/p/app/tsconfig.json", files["/p/app/tsconfig.json"]!)).toEqual(["/p/tsconfig.base"]);
    expect(await effectiveCmkState("/p/app/tsconfig.json", read)).toBe("enabled");
    expect(await effectiveCmkState("/p/web/tsconfig.json", read)).toBe("set");
    expect(await effectiveCmkState("/p/own/tsconfig.json", read)).toBe("set");
    expect(await effectiveCmkState("/p/loop/tsconfig.json", read)).toBe("absent");
  });

  it("adds the option as the first property, keeping the file's comments and indentation", () => {
    const tsconfig = '// app\n{\n    // strict\n    "compilerOptions": { "strict": true }\n}\n';
    const edited = insert(tsconfig);
    expect(edited).toBe(
      '// app\n{\n    "cmkOptions": { "enabled": true },\n    // strict\n    "compilerOptions": { "strict": true }\n}\n',
    );
    expect(cmkState(edited)).toBe("enabled");
    expect(insert("{}")).toBe('{\n  "cmkOptions": { "enabled": true }\n}');
    expect(cmkState(insert("{ /* empty */ }"))).toBe("enabled");
    expect(cmkOptionsInsertion("[]")).toBeNull();
  });

  it("looks for CSS Modules in stylesheets and the scripts that import them", () => {
    expect(usesCssModules("/p/src/Button.module.css", null)).toBe(true);
    expect(usesCssModules("/p/src/app.css", null)).toBe(false);
    expect(usesCssModules("/p/src/Button.tsx", "import s from './Button.module.css';")).toBe(true);
    expect(usesCssModules("/p/src/Button.tsx", "import './app.css';")).toBe(false);
    expect(usesCssModules("/p/README.md", "Button.module.css")).toBe(false);
  });

  it("enables through the document and saves it, restarting nothing itself", async () => {
    // tsconfig.json open with an unsaved change: the edit goes into that text, then it is saved.
    const text = '{\n  "compilerOptions": {},\n  "exclude": ["dist"]\n}\n';
    const calls: string[] = [];
    ipc.docOpen.mockImplementation(async () => (calls.push("open"), ok({ id: 7, text, dirty: true })));
    ipc.applyWorkspaceEdit.mockImplementation(async () => (calls.push("edit"), ok(null)));
    ipc.docSave.mockImplementation(async () => (calls.push("save"), ok(null)));
    ipc.docClose.mockImplementation(async () => (calls.push("close"), ok(null)));
    const run = async (status: string) => {
      calls.length = 0;
      store.status = status;
      store.installTool.mockClear();
      await enable("/p/tsconfig.json", "tsconfig.json");
      await Promise.resolve();
      expect(calls).toEqual(["open", "edit", "save", "close"]);
      const [edit] = ipc.applyWorkspaceEdit.mock.lastCall!;
      expect(edit.files[0].edits[0]).toEqual({
        range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } },
        new_text: '\n  "cmkOptions": { "enabled": true },',
      });
      // The tsconfig.json change reconfigures vtsls once; the install, when needed, does too.
      expect(ipc.lspRestartNamed).not.toHaveBeenCalled();
      expect(store.installTool).toHaveBeenCalledTimes(status === "missing" ? 1 : 0);
    };
    await run("installed");
    await run("missing");
  });
});
