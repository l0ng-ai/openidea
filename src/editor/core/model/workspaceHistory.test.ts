import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redo, redoDepth, undo, undoDepth, history } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { workspaceEditHistory } from "@/editor/api";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { createMemoryBackend, type MemoryBackend } from "../backend";
import { _resetLanguages } from "../cm/languages";
import { DocumentManager } from "./document";
import { EditorSlot, type SlotHost } from "./slot";
import { attachDocument } from "./attachment";

const commands = vi.hoisted(() => ({ undoWorkspaceEdit: vi.fn(), redoWorkspaceEdit: vi.fn() }));
vi.mock("@/bindings", () => ({ commands }));
const host: SlotHost = { onFocus() {}, onBlur() {}, onSelection() {}, onUserEdit() {}, onContextMenu() {} };
let manager: DocumentManager;
let backend: MemoryBackend;
let notify = vi.fn<(n: { level: "info" | "warning" | "error"; title: string; body?: string }) => void>();
let slots: EditorSlot[];
let attached: EditorView | null;

beforeEach(() => {
  _resetLanguages();
  backend = createMemoryBackend({ "/p/A.java": "old", "/p/B.java": "old", "/p/closed.java": "old" });
  notify = vi.fn();
  manager = new DocumentManager(backend, { settings: () => ({ files: { autoSave: false } }), notify });
  manager.start();
  slots = [];
  attached = null;
  commands.undoWorkspaceEdit.mockReset().mockImplementation(async () => {
    await replace("old");
    return { status: "ok", data: null };
  });
  commands.redoWorkspaceEdit.mockReset().mockImplementation(async () => {
    await replace("new");
    return { status: "ok", data: null };
  });
});
afterEach(() => {
  attached?.destroy();
  slots.forEach((s) => s.dispose());
  manager.stop();
});

async function open(path: string) {
  const slot = new EditorSlot(await manager.acquire(path), String(slots.length), host);
  slots.push(slot);
  return slot;
}
async function replace(text: string) {
  for (const d of backend.docs.values()) {
    backend.patch(d.id, [{ from: 0, to: 3, insert: text }], true);
    await backend.save(d.id);
  }
  backend.files.set("/p/closed.java", text);
}
async function rename() {
  await replace("new");
  emitLocalIdeEvent({ type: "workspaceEditApplied", id: 9, paths: ["/p/A.java", "/p/B.java", "/p/closed.java"] });
}
function historyStep(slot: EditorSlot, forward = false) {
  return (forward ? redo : undo)({
    state: slot.currentState(),
    dispatch: (tr) => {
      slot.state = tr.state;
    },
  });
}

it("editor Undo and Redo restore the entire Java rename, with one step in every split and background tab", async () => {
  const a = await open("/p/A.java");
  const split = await open("/p/A.java");
  const b = await open("/p/B.java");
  await rename();
  for (const s of slots) expect(undoDepth(s.currentState())).toBe(1);
  expect(historyStep(split)).toBe(true);
  await vi.waitFor(() => expect(backend.files.get("/p/closed.java")).toBe("old"));
  for (const s of slots) {
    expect(s.currentState().doc.toString()).toBe("old");
    expect(undoDepth(s.currentState())).toBe(0);
    expect(redoDepth(s.currentState())).toBe(1);
  }
  expect(commands.undoWorkspaceEdit).toHaveBeenCalledExactlyOnceWith(9);
  historyStep(b, true);
  await vi.waitFor(() => expect(backend.files.get("/p/closed.java")).toBe("new"));
  expect(a.currentState().doc.toString()).toBe("new");
  expect(undoDepth(a.currentState())).toBe(1);
  expect(commands.redoWorkspaceEdit).toHaveBeenCalledExactlyOnceWith(9);
});

it("notification Undo consumes the same marker and never makes Cmd+Z reapply a single file", async () => {
  const a = await open("/p/A.java");
  await rename();
  await workspaceEditHistory(9);
  expect(a.currentState().doc.toString()).toBe("old");
  expect(historyStep(a)).toBe(false);
  expect(redoDepth(a.currentState())).toBe(1);
  expect(commands.undoWorkspaceEdit).toHaveBeenCalledOnce();
});

it("preserves earlier local history and refuses the notification until later typing is undone", async () => {
  const a = await open("/p/A.java");
  a.dispatchLocal({ changes: { from: 3, insert: "!" }, userEvent: "input.type" });
  await a.model.sync.whenIdle();
  await rename();
  a.dispatchLocal({ changes: { from: 4, insert: "?" }, userEvent: "input.type" });
  await expect(workspaceEditHistory(9)).rejects.toThrow("Undo newer editor changes");
  expect(commands.undoWorkspaceEdit).not.toHaveBeenCalled();
  undo({ state: a.currentState(), dispatch: (tr) => a.dispatchLocal(tr) });
  await a.model.sync.whenIdle();
  await workspaceEditHistory(9);
  expect(a.currentState().doc.toString()).toBe("old!");
  expect(undoDepth(a.currentState())).toBe(1);
});

it("restores the editor marker when backend guards refuse Undo", async () => {
  const a = await open("/p/A.java");
  await rename();
  commands.undoWorkspaceEdit.mockResolvedValue({
    status: "error",
    error: { kind: "outOfSync", message: "external write" },
  });
  historyStep(a);
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  expect(a.currentState().doc.toString()).toBe("new");
  expect(undoDepth(a.currentState())).toBe(1);
  expect(redoDepth(a.currentState())).toBe(0);
});

it("supports direct CodeMirror Undo from an attached diff view", async () => {
  const att = await attachDocument(manager, "/p/A.java");
  attached = new EditorView({ doc: att.text(), extensions: [att.extension, history()] });
  await Promise.resolve();
  await rename();
  undo(attached);
  await vi.waitFor(() => expect(attached!.state.doc.toString()).toBe("old"));
  expect(commands.undoWorkspaceEdit).toHaveBeenCalledOnce();
  expect(undoDepth(attached.state)).toBe(0);
  attached.destroy();
  attached = null;
  att.release();
});
