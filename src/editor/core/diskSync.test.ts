import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { installDiskSync } from "./diskSync";
import { EditorController } from "./controller";
import { createMemoryBackend } from "./backend";

vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: vi.fn().mockResolvedValue(true),
}));

let dispose: (() => void) | undefined;
let controller: EditorController | undefined;
const focus = () => window.dispatchEvent(new Event("focus"));
const settings = (syncOnFocus = true) => ({ files: { syncOnFocus, autoSave: false } }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useProject.setState({
    project: { root: "/project" } as never,
    settings: settings(),
    opening: false,
    lightEdit: false,
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  controller?.stop();
  controller = undefined;
  useProject.setState({ project: null, settings: null, lightEdit: false, opening: false });
  vi.useRealTimers();
});

describe("window disk synchronization", () => {
  it("debounces focus events and refreshes the project tree and VCS", async () => {
    const sync = vi.fn().mockResolvedValue(undefined);
    dispose = installDiskSync(sync, () => true);
    focus();
    await vi.advanceTimersByTimeAsync(150);
    focus();
    await vi.advanceTimersByTimeAsync(199);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledOnce();
    expect(vi.mocked(executeAction).mock.calls).toEqual([["project.refresh"], ["vcs.refresh"]]);
  });

  it("defaults on for older settings and does nothing when the setting is off", async () => {
    const sync = vi.fn().mockResolvedValue(undefined);
    dispose = installDiskSync(sync, () => true);
    useProject.setState({ settings: {} as never });
    focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledOnce();
    sync.mockClear();
    vi.mocked(executeAction).mockClear();
    useProject.setState({ settings: settings(false) });
    focus();
    await vi.advanceTimersByTimeAsync(500);
    expect(sync).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it.each(["setting", "project", "opening", "closing", "dispose"])(
    "cancels pending sync on %s changes",
    async (change) => {
      let canSync = true;
      const sync = vi.fn().mockResolvedValue(undefined);
      dispose = installDiskSync(sync, () => canSync);
      focus();
      if (change === "setting") useProject.setState({ settings: settings(false) });
      if (change === "project") useProject.setState({ project: { root: "/other" } as never });
      if (change === "opening") useProject.setState({ opening: true });
      if (change === "closing") canSync = false;
      if (change === "dispose") dispose();
      await vi.advanceTimersByTimeAsync(200);
      expect(sync).not.toHaveBeenCalled();
      expect(executeAction).not.toHaveBeenCalled();
    },
  );

  it("ignores welcome windows and synchronizes LightEdit without project refreshes", async () => {
    const sync = vi.fn().mockResolvedValue(undefined);
    dispose = installDiskSync(sync, () => true);
    useProject.setState({ project: null });
    focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).not.toHaveBeenCalled();
    useProject.setState({ lightEdit: true });
    focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledOnce();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("coalesces focus during a slow check into a follow-up and removes its listener", async () => {
    let finish!: () => void;
    const sync = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    dispose = installDiskSync(sync, () => true);
    focus();
    await vi.advanceTimersByTimeAsync(200);
    focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(2);
    dispose();
    focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not refresh a replacement project when an old check finishes", async () => {
    let finish!: () => void;
    dispose = installDiskSync(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      () => true,
    );
    focus();
    await vi.advanceTimersByTimeAsync(200);
    useProject.setState({ project: { root: "/other" } as never });
    finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("controller preserves the unchanged document's selection and scroll, then stops checking", async () => {
    useProject.setState({ project: null, lightEdit: true });
    const syncFromDisk = vi.fn().mockResolvedValue(undefined);
    const backend = { ...createMemoryBackend({ "/file.txt": "line\n".repeat(100) }), syncFromDisk };
    controller = new EditorController(backend);
    controller.start();
    await controller.openFile("/file.txt", { focus: false });
    const slot = controller.activeSlot!;
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const view = slot.mount(host);
      controller.onMounted(slot);
      view.dispatch({ selection: { anchor: 150 } });
      view.scrollDOM.scrollTop = 80;
      const state = view.state;
      focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(syncFromDisk).toHaveBeenCalledOnce();
      expect(view.state.doc).toBe(state.doc);
      expect(view.state.selection.eq(state.selection)).toBe(true);
      expect(view.state.selection.main.anchor).toBe(150);
      expect(view.scrollDOM.scrollTop).toBe(80);
      controller.stop();
      controller = undefined;
      focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(syncFromDisk).toHaveBeenCalledOnce();
    } finally {
      host.remove();
    }
  });
});
