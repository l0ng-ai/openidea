import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/dialog", () => ({ save: vi.fn(async () => null) }));
const ask = vi.fn(async () => ({ button: "cancel" }));
vi.mock("@/workbench/messages", () => ({
  ask: (...args: unknown[]) => ask(...(args as [])),
  confirm: vi.fn(async () => false),
}));

const { EditorController, isTextInput, tabTitle, untitledInput, useTabs } = await import("./controller");
const { createMemoryBackend } = await import("./backend");
type MemoryBackend = Awaited<ReturnType<typeof createMemoryBackend>>;
const { initialTabsState } = await import("./model/tabs");
const { serializeSession } = await import("./model/session");
const { useDocMeta } = await import("./model/document");
const { save } = await import("@/platform/dialog");
const editorKinds = await import("@/workbench/contributions");

let ctrl: InstanceType<typeof EditorController> | null = null;
let backend: MemoryBackend;

beforeEach(() => {
  backend = createMemoryBackend({ "/p/main.rs": "fn main() {}\n" });
  ctrl = new EditorController(backend);
  ctrl.start();
});

afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
  vi.clearAllMocks();
});

const activeTab = () => {
  const s = useTabs.getState();
  const pane = s.panes[s.activePane]!;
  return pane.tabs.find((t) => t.id === pane.active)!;
};

const editActive = async (insert: string) => {
  const slot = ctrl!.slotFor(activeTab().id)!;
  slot.dispatchLocal({ changes: { from: 0, insert } });
  const model = slot.model;
  // The dirty flag arrives with the backend's acknowledgement.
  await vi.waitFor(() => expect(model.getMeta().dirty).toBe(true));
  return model;
};

describe("untitled editor input", () => {
  it("opens editable, pathless buffers with incrementing names", async () => {
    await ctrl!.openUntitled({ focus: false });
    const tab = activeTab();
    expect(tab.input).toEqual({ kind: "untitled", key: "untitled:Untitled-1", path: "untitled:Untitled-1" });
    expect(isTextInput(tab.input)).toBe(true);
    expect(tabTitle(tab.input, editorKinds.useContributions.getState().editorKinds)).toBe("Untitled-1");
    const slot = ctrl!.slotFor(tab.id)!;
    expect(slot.model.virtual).toBe(false);
    expect(slot.model.ctx()).toMatchObject({ path: "untitled:Untitled-1", language: "plaintext" });
    expect(useDocMeta.getState()["untitled:Untitled-1"]).toMatchObject({ dirty: false, readOnly: false });

    await editActive("draft");
    expect(slot.model.getMeta().dirty).toBe(true);

    await ctrl!.openUntitled({ focus: false });
    expect(activeTab().input.path).toBe("untitled:Untitled-2");
    expect(untitledInput("untitled:Untitled-9").key).toBe("untitled:Untitled-9");
  });

  it("autosave never writes an untitled buffer; explicit save asks for a path and retargets tab and model", async () => {
    await ctrl!.openUntitled({ focus: false });
    const model = await editActive("draft");
    vi.mocked(save).mockResolvedValue("/p/new/dir/hello.rs");

    await model.save("auto");
    expect(save).not.toHaveBeenCalled();
    expect(model.getMeta().dirty).toBe(true);

    await model.save("explicit");
    // No content guessing: the bare name plus the type dropdown (filters).
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Untitled-1", filters: expect.any(Array) }),
    );
    expect(activeTab().input).toMatchObject({ kind: "file", path: "/p/new/dir/hello.rs" });
    expect(model.path).toBe("/p/new/dir/hello.rs");
    expect(model.getMeta().dirty).toBe(false);
    expect(useDocMeta.getState()["/p/new/dir/hello.rs"]).toBeDefined();
    expect(useDocMeta.getState()["untitled:Untitled-1"]).toBeUndefined();
    // Save cleanup adds the final newline.
    expect(backend.files.get("/p/new/dir/hello.rs")).toBe("draft\n");
    // Saved as .rs: the buffer is a regular file document again.
    expect(model.virtual).toBe(false);
    expect((await backend.snapshot(model.doc)).uri).toBeUndefined();

    // The session keeps the saved file but never an unsaved untitled buffer.
    await ctrl!.openUntitled({ focus: false });
    await editActive("second");
    const session = serializeSession(useTabs.getState(), {});
    expect(JSON.stringify(session)).toContain("/p/new/dir/hello.rs");
    expect(JSON.stringify(session)).not.toContain("untitled:");
  });

  it("offers the registered languages as save-as types", async () => {
    await ctrl!.openUntitled({ focus: false });
    const slot = ctrl!.slotFor(activeTab().id)!;
    slot.dispatchLocal({ changes: { from: 0, insert: "{}" } });
    vi.mocked(save).mockResolvedValue("/p/anywhere/x.md");
    await slot.model.save("explicit");
    const call = vi.mocked(save).mock.calls.at(-1)![0]!;
    const types = (call.filters ?? []).map((f: { name: string }) => f.name);
    // Plain text first (the default), registered languages in between, all-files last.
    expect(types[0]).toBe("Text files (*.txt)");
    expect(types.at(-1)).toBe("All files (*.*)");
    // The name carries no extension: the picked type decides it.
    expect(call.defaultPath).toBe("Untitled-1");
    // The name carries no extension: the picked type decides it.
    expect(call.defaultPath).toBe("Untitled-1");
  });

  it("keeps the buffer open and dirty when the save dialog is cancelled", async () => {
    await ctrl!.openUntitled({ focus: false });
    const model = await editActive("draft");
    vi.mocked(save).mockResolvedValue(null);

    await model.save("explicit");
    expect(activeTab().input.kind).toBe("untitled");
    expect(model.getMeta().dirty).toBe(true);
    expect([...backend.files.keys()]).toEqual(["/p/main.rs"]);
  });

  it("asks about a dirty untitled buffer when its last tab closes", async () => {
    await ctrl!.openUntitled({ focus: false });
    const tab = activeTab();
    await editActive("draft");
    const paneId = useTabs.getState().activePane;

    // Cancel keeps the tab.
    ask.mockResolvedValue({ button: "cancel" });
    expect(await ctrl!.closeTab(paneId, tab.id)).toBe(false);
    expect(activeTab().id).toBe(tab.id);

    // Save closes it through the Save As dialog.
    ask.mockResolvedValue({ button: "save" });
    vi.mocked(save).mockResolvedValue("/p/kept.txt");
    expect(await ctrl!.closeTab(paneId, tab.id)).toBe(true);
    expect(Object.values(useTabs.getState().panes).flatMap((p) => p.tabs)).toHaveLength(0);
    expect(backend.files.get("/p/kept.txt")).toBe("draft\n");
  });

  it("closes an untitled buffer without saving when the user declines", async () => {
    await ctrl!.openUntitled({ focus: false });
    const tab = activeTab();
    await editActive("draft");
    const paneId = useTabs.getState().activePane;
    ask.mockResolvedValue({ button: "discard" });
    expect(await ctrl!.closeTab(paneId, tab.id)).toBe(true);
    expect(Object.values(useTabs.getState().panes).flatMap((p) => p.tabs)).toHaveLength(0);
    expect([...backend.files.keys()]).toEqual(["/p/main.rs"]);
  });

  it("reuses the buffer for a re-opened untitled name and shares it across tabs", async () => {
    const info = await backend.openUntitled(null);
    const twice = await backend.openUntitled("untitled:Untitled-1");
    expect(twice.id).toBe(info.id);
    await ctrl!.openInput(untitledInput(info.path), { focus: false });
    await ctrl!.openInput(untitledInput(info.path), { focus: false, side: true });
    const tabs = Object.values(useTabs.getState().panes).flatMap((p) => p.tabs);
    expect(tabs).toHaveLength(2);
    expect(ctrl!.slotFor(tabs[0]!.id)!.model).toBe(ctrl!.slotFor(tabs[1]!.id)!.model);
  });
});
