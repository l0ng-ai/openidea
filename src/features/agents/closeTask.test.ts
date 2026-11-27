import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeActiveTask, closeAndNewTask, useAgents } from "./store";

const editor = vi.hoisted(() => ({
  active: null as { kind: string; key: string; data?: unknown } | null,
  close: vi.fn<(key: string) => Promise<boolean>>(),
  open: vi.fn(),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    activeInput: () => editor.active,
    closeInput: editor.close,
    openInput: editor.open,
    activePath: () => null,
  }),
  maybeEditorService: () => ({ activePath: () => null }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const SESSION = { kind: "agent-session", key: "agent-session:t1", data: { task: "t1" } };
const FILE = { kind: "file", key: "/p/a.ts" };

beforeEach(() => {
  editor.close.mockReset().mockResolvedValue(true);
  editor.open.mockReset();
  useAgents.setState({ sessionLocation: "editor" });
});

describe("Close Agent Task", () => {
  it("closes the agent task tab in focus and leaves other tabs alone", async () => {
    editor.active = SESSION;
    expect(await closeActiveTask()).toBe(true);
    expect(editor.close).toHaveBeenCalledExactlyOnceWith(SESSION.key);

    editor.close.mockClear();
    editor.active = FILE;
    expect(closeActiveTask()).toBeNull();
    expect(editor.close).not.toHaveBeenCalled();
  });

  it("Close and New opens the New Task page, unless closing was cancelled", async () => {
    editor.active = SESSION;
    await closeAndNewTask();
    expect(editor.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-home" }), { focus: true });

    editor.open.mockClear();
    editor.active = FILE;
    await closeAndNewTask();
    expect(editor.close).toHaveBeenCalledTimes(1);
    expect(editor.open).toHaveBeenCalledTimes(1);

    editor.open.mockClear();
    editor.active = SESSION;
    editor.close.mockResolvedValue(false);
    await closeAndNewTask();
    expect(editor.open).not.toHaveBeenCalled();
  });
});
