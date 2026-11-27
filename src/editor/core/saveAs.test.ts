import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/dialog", () => ({ save: vi.fn(async () => null) }));

const { EditorController, useTabs } = await import("./controller");
const { createMemoryBackend } = await import("./backend");
type MemoryBackend = Awaited<ReturnType<typeof createMemoryBackend>>;
const { initialTabsState } = await import("./model/tabs");
const { save } = await import("@/platform/dialog");
const contributions = await import("@/workbench/contributions");
const { useProject } = await import("@/platform/project");

const sourcePath = "/p/source.txt";
const initialSettings = useProject.getState().settings;
let ctrl: InstanceType<typeof EditorController>;
let backend: MemoryBackend;

beforeEach(() => {
  useProject.setState({ settings: initialSettings });
  backend = createMemoryBackend({ [sourcePath]: "saved\n" });
  ctrl = new EditorController(backend);
  ctrl.start();
  vi.mocked(save).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  ctrl.stop();
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ settings: initialSettings });
  vi.restoreAllMocks();
});

const tabs = () => Object.values(useTabs.getState().panes).flatMap((pane) => pane.tabs);
const activeTab = () => {
  const state = useTabs.getState();
  const pane = state.panes[state.activePane]!;
  return pane.tabs.find((tab) => tab.id === pane.active)!;
};
const tabFor = (path: string) => tabs().find((tab) => tab.input.path === path);

async function openSource(text = "dirty\n", preview = false) {
  await ctrl.openFile(sourcePath, { focus: false, preview });
  const tab = activeTab();
  const slot = ctrl.slotFor(tab.id)!;
  if (text !== slot.currentState().doc.toString())
    slot.dispatchLocal({
      changes: { from: 0, to: slot.currentState().doc.length, insert: text },
      userEvent: "input.type",
    });
  await vi.waitFor(() => expect(slot.model.getMeta().dirty).toBe(true));
  return { tab, slot, model: slot.model };
}

describe("EditorController Save As", () => {
  it("copies dirty text, opens an active copy, and never autosaves or changes the source", async () => {
    const source = await openSource();
    const saveSpy = vi.spyOn(backend, "save");
    const copySpy = vi.spyOn(backend, "copyAs");
    vi.mocked(save).mockImplementation(async () => {
      // A native file chooser can blur the IDE before it returns a destination.
      window.dispatchEvent(new Event("blur"));
      return "/p/copy.txt";
    });

    expect(await ctrl.saveAs()).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: "Save As", defaultPath: sourcePath }));
    expect(copySpy).toHaveBeenCalledWith(source.model.doc, "/p/copy.txt");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(backend.files.get("/p/copy.txt")).toBe("dirty\n");

    expect(tabs().map((tab) => tab.input.path)).toEqual([sourcePath, "/p/copy.txt"]);
    expect(activeTab().input.path).toBe("/p/copy.txt");
    expect(ctrl.activeSlot?.model.path).toBe("/p/copy.txt");
    expect(ctrl.activeSlot?.currentState().doc.toString()).toBe("dirty\n");
    expect(ctrl.activeSlot?.model.getMeta().dirty).toBe(false);
    expect(tabFor(sourcePath)?.id).toBe(source.tab.id);
    expect(ctrl.slotFor(source.tab.id)).toBe(source.slot);
    expect(source.slot.currentState().doc.toString()).toBe("dirty\n");
    expect(source.model.path).toBe(sourcePath);
    expect(source.model.getMeta().dirty).toBe(true);
  });

  it("is a no-op when the destination chooser is cancelled", async () => {
    const source = await openSource();
    const copySpy = vi.spyOn(backend, "copyAs");

    expect(await ctrl.saveAs()).toBe(false);
    expect(copySpy).not.toHaveBeenCalled();
    expect(activeTab().id).toBe(source.tab.id);
    expect(tabs()).toHaveLength(1);
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(source.model.getMeta().dirty).toBe(true);
  });

  it("does not overwrite or duplicate the file when the same path is chosen", async () => {
    const source = await openSource();
    const copySpy = vi.spyOn(backend, "copyAs");
    vi.mocked(save).mockResolvedValue(sourcePath);

    expect(await ctrl.saveAs()).toBe(false);
    expect(copySpy).not.toHaveBeenCalled();
    expect(tabs()).toHaveLength(1);
    expect(activeTab().id).toBe(source.tab.id);
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(source.model.getMeta().dirty).toBe(true);
  });

  it("does not open a duplicate when the backend recognizes a source-path alias", async () => {
    const source = await openSource();
    vi.mocked(save).mockResolvedValue("/p/./source.txt");
    vi.spyOn(backend, "copyAs").mockResolvedValue(false);

    expect(await ctrl.saveAs()).toBe(false);
    expect(tabs()).toHaveLength(1);
    expect(activeTab().id).toBe(source.tab.id);
    expect(backend.files.get(sourcePath)).toBe("saved\n");
  });

  it("replaces an existing destination after the chooser accepts overwrite", async () => {
    backend.files.set("/p/existing.txt", "old\n");
    await openSource();
    vi.mocked(save).mockResolvedValue("/p/existing.txt");

    expect(await ctrl.saveAs()).toBe(true);
    expect(backend.files.get("/p/existing.txt")).toBe("dirty\n");
    expect(activeTab().input.path).toBe("/p/existing.txt");
    expect(tabs().map((tab) => tab.input.path)).toEqual([sourcePath, "/p/existing.txt"]);
  });

  it("leaves the existing destination untouched when replacement is declined", async () => {
    backend.files.set("/p/existing.txt", "old\n");
    const source = await openSource();
    const copySpy = vi.spyOn(backend, "copyAs");
    // The save chooser resolves null when its overwrite confirmation is declined
    // and the user then cancels instead of choosing another destination.
    vi.mocked(save).mockResolvedValue(null);

    expect(await ctrl.saveAs()).toBe(false);
    expect(copySpy).not.toHaveBeenCalled();
    expect(backend.files.get("/p/existing.txt")).toBe("old\n");
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(activeTab().id).toBe(source.tab.id);
  });

  it("keeps a clean preview source tab even when the tab limit is one", async () => {
    useProject.setState({ settings: { editor: { tabs: { tabLimit: 1, closingPolicy: "lru" } } } as never });
    await ctrl.openFile(sourcePath, { focus: false, preview: true });
    const source = activeTab();
    expect(source.preview).toBe(true);
    vi.mocked(save).mockResolvedValue("/p/copy.txt");

    expect(await ctrl.saveAs()).toBe(true);
    expect(tabs().map((tab) => tab.input.path)).toEqual([sourcePath, "/p/copy.txt"]);
    expect(tabFor(sourcePath)).toMatchObject({ id: source.id, preview: true });
    expect(activeTab().input.path).toBe("/p/copy.txt");
  });

  it("notifies when the written copy cannot be opened and returns to the untouched source", async () => {
    const source = await openSource();
    const notify = vi.fn();
    vi.spyOn(contributions, "notifications").mockReturnValue({ notify } as never);
    const open = backend.open.bind(backend);
    vi.spyOn(backend, "open").mockImplementation(async (path) => {
      if (path === "/p/copy.txt") throw new Error("open failed");
      return open(path);
    });
    vi.mocked(save).mockResolvedValue("/p/copy.txt");

    expect(await ctrl.saveAs()).toBe(false);
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "Cannot open file", body: "open failed" });
    expect(activeTab().id).toBe(source.tab.id);
    expect(tabs()).toHaveLength(1);
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(backend.files.get("/p/copy.txt")).toBe("dirty\n");
    expect(source.model.getMeta().dirty).toBe(true);
  });

  it("notifies a copy failure and leaves the original active and untouched", async () => {
    const source = await openSource();
    const notify = vi.fn();
    vi.spyOn(contributions, "notifications").mockReturnValue({ notify } as never);
    vi.spyOn(backend, "copyAs").mockRejectedValue(new Error("disk full"));
    vi.mocked(save).mockResolvedValue("/p/copy.txt");

    expect(await ctrl.saveAs()).toBe(false);
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "Cannot save file", body: "disk full" });
    expect(activeTab().id).toBe(source.tab.id);
    expect(tabs()).toHaveLength(1);
    expect(backend.files.get(sourcePath)).toBe("saved\n");
    expect(backend.files.has("/p/copy.txt")).toBe(false);
    expect(source.model.getMeta().dirty).toBe(true);
  });
});

describe("memory document backend Save As copy", () => {
  it("copies the acknowledged dirty buffer without saving or retargeting its source", async () => {
    const memory = createMemoryBackend({ [sourcePath]: "saved\n" });
    const source = await memory.open(sourcePath);
    await memory.edit(source.id, source.version, [{ from: 0, to: 0, insert: "dirty " }]);
    const before = await memory.snapshot(source.id);

    await memory.copyAs(source.id, "/p/copy.txt");
    expect(memory.files.get(sourcePath)).toBe("saved\n");
    expect(memory.files.get("/p/copy.txt")).toBe("dirty saved\n");
    expect(await memory.snapshot(source.id)).toEqual(before);
    expect(memory.docs.size).toBe(1);

    const copy = await memory.open("/p/copy.txt");
    expect(copy.id).not.toBe(source.id);
    expect(copy.text).toBe("dirty saved\n");
    expect(copy.dirty).toBe(false);
    expect((await memory.snapshot(source.id)).dirty).toBe(true);
  });

  it("treats the source path as a no-op and refuses to overwrite another open document", async () => {
    const memory = createMemoryBackend({ [sourcePath]: "saved\n", "/p/open.txt": "open\n" });
    const source = await memory.open(sourcePath);
    const other = await memory.open("/p/open.txt");

    await memory.copyAs(source.id, sourcePath);
    expect(memory.docs.size).toBe(2);
    expect(memory.files.get(sourcePath)).toBe("saved\n");
    await expect(memory.copyAs(source.id, "/p/open.txt")).rejects.toMatchObject({ kind: "invalidInput" });
    expect(memory.files.get("/p/open.txt")).toBe("open\n");
    expect((await memory.snapshot(other.id)).text).toBe("open\n");
  });
});
