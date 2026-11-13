/**
 * CLI editor tabs (#2202): input kinds and data validation, the saved CLIs
 * (global), and the launch / start flows through the terminal runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliData,
  cliInput,
  decodeSavedClis,
  launchCli,
  openCliLauncher,
  readSavedClis,
  removeSavedCli,
  saveCli,
  startTab,
  useSavedClis,
  CLI_LAUNCHER_KEY,
  type SavedCli,
} from "./cli";

const runtime = vi.hoisted(() => ({
  loaded: false,
  startCli: vi.fn(),
}));
const editor = vi.hoisted(() => ({
  openInput: vi.fn(async (_input?: unknown, _options?: unknown) => undefined),
  closeInput: vi.fn(async (_key?: unknown) => true),
}));

vi.mock("./loader", () => ({
  loadTerminalRuntime: async () => runtime,
  terminalRuntime: () => (runtime.loaded ? runtime : null),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => editor,
}));

import { useProject } from "@/platform/project";

const root = () => useProject.getState().project?.root ?? null;

beforeEach(() => {
  runtime.loaded = true;
  useProject.setState({ project: { root: "/repo" } as never });
});
afterEach(() => {
  useProject.setState({ project: null, settings: null });
  useSavedClis.setState({ saved: [] });
  localStorage.clear();
  vi.clearAllMocks();
});

describe("CLI input data", () => {
  it("validates untrusted session data", () => {
    const input = cliInput("Claude Code", "claude --continue");
    expect(cliData(input)).toEqual({ name: "Claude Code", command: "claude --continue" });
    expect(cliData({ ...input, data: undefined })).toBeNull();
    expect(cliData({ ...input, data: { name: "  ", command: "x" } })).toBeNull();
    expect(cliData({ ...input, data: { name: " A ", command: 3 } })).toEqual({ name: "A", command: "" });
    expect(cliData({ ...input, kind: "file", path: "/repo/a.ts" })).toBeNull();
  });

  it("mints a fresh key per launch, so restored tabs are their own", () => {
    const a = cliInput("A", "a");
    const b = cliInput("A", "a");
    expect(a.key).not.toBe(b.key);
    expect(a.kind).toBe("cli");
  });
});

describe("saved CLIs", () => {
  it("decodes untrusted JSON: strings only, unique ids, capped", () => {
    expect(decodeSavedClis(null)).toEqual([]);
    expect(decodeSavedClis("x")).toEqual([]);
    const good: SavedCli = { id: "a", name: " A ", command: " aider " };
    expect(decodeSavedClis([good, { id: "b", name: "B", command: "" }, { id: "a", name: "C", command: "c" }])).toEqual([
      { id: "a", name: "A", command: "aider" },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `N${i}`, command: `c${i}` }));
    expect(decodeSavedClis(many)).toHaveLength(32);
  });

  it("saves and removes for every project", () => {
    saveCli("Claude Code", "claude");
    saveCli("Aider", "aider --model x");
    expect(useSavedClis.getState().saved.map((s) => s.name)).toEqual(["Claude Code", "Aider"]);
    const again = readSavedClis();
    expect(again).toEqual(useSavedClis.getState().saved);
    removeSavedCli(again[0]!.id);
    expect(readSavedClis().map((s) => s.name)).toEqual(["Aider"]);
  });
});

describe("launching", () => {
  it("starts the session in the project root and opens its tab", async () => {
    await launchCli("Claude Code", "claude --continue");
    const input = editor.openInput.mock.calls[0]?.[0] as { kind: string; key: string; data: unknown };
    expect(input.kind).toBe("cli");
    expect(input.data).toEqual({ name: "Claude Code", command: "claude --continue" });
    expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith(input.key, "/repo", "claude --continue");
    // The session exists before the tab mounts, so it attaches instead of showing Start.
    expect(runtime.startCli.mock.invocationCallOrder[0]).toBeLessThan(editor.openInput.mock.invocationCallOrder[0]!);
    // The launcher tab makes way for the new CLI.
    expect(editor.closeInput).toHaveBeenCalledWith(CLI_LAUNCHER_KEY);
  });

  it("starts a restored tab's CLI where it stands", async () => {
    const input = cliInput("Codex", "codex --yolo");
    await startTab(input);
    expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith(input.key, "/repo", "codex --yolo");
    expect(editor.openInput).not.toHaveBeenCalled();
  });

  it("opens the launcher tab", async () => {
    await openCliLauncher();
    expect(editor.openInput).toHaveBeenCalledExactlyOnceWith(
      { kind: "cli.launcher", key: CLI_LAUNCHER_KEY, data: {} },
      { focus: true },
    );
  });

  it("does nothing without a project", async () => {
    useProject.setState({ project: null });
    await launchCli("A", "a");
    await startTab(cliInput("A", "a"));
    expect(runtime.startCli).not.toHaveBeenCalled();
    expect(editor.openInput).not.toHaveBeenCalled();
    expect(root()).toBeNull();
  });
});
