import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/platform/ipc";
import { useProject } from "@/platform/project";
import * as services from "@/workbench/contributions";
import type { MessageRequest as PromptRequest } from "@/workbench/messages";
import { installCloseGuard, quitApp, type CloseDeps } from "../closeGuard";

const native = vi.hoisted(() => ({
  close: undefined as ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
  order: [] as string[],
}));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: async () => [],
  getCurrentWindow: () => ({
    label: "main",
    listen: async () => () => {},
    onCloseRequested: async (callback: typeof native.close) => {
      native.close = callback;
      return () => {};
    },
    unminimize: async () => void native.order.push("unminimize"),
    show: async () => void native.order.push("show"),
    setFocus: async () => void native.order.push("setFocus"),
  }),
}));

const initialProject = useProject.getState();
let uninstall: (() => void) | undefined;
let deps: CloseDeps;
const forget = vi.fn();
const keep = vi.fn();

beforeEach(() => {
  vi.spyOn(ipc, "isTauri").mockReturnValue(true);
  vi.spyOn(ipc, "onIdeEvent").mockReturnValue(() => {});
  vi.spyOn(ipc.commands, "windowCloseContext").mockResolvedValue({ quitting: false, windows: 1 });
  vi.spyOn(ipc.commands, "windowGroupCancelClose").mockResolvedValue(undefined);
  vi.spyOn(ipc.commands, "appCancelQuit").mockResolvedValue(undefined);
  vi.spyOn(ipc.commands, "closeProject").mockResolvedValue(undefined);
  vi.spyOn(services, "maybeEditorService").mockReturnValue({
    forgetSavedTabs: forget,
    keepSavedTabs: keep,
    dirtyDocumentIds: () => [],
    cancelClose: vi.fn(),
  } as never);
  deps = {
    ask: vi.fn(async () => ({ button: "cancel", checked: false })),
    saveAll: vi.fn(async () => {}),
    disableConfirmExit: vi.fn(async () => {}),
    disableConfirmTerminate: vi.fn(async () => {}),
    runningProcesses: vi.fn(async () => []),
    onSaveFailed: vi.fn(),
  };
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  native.close = undefined;
  useProject.setState(initialProject, true);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function close(general: Record<string, boolean>, lightEdit = false) {
  useProject.setState({
    project: lightEdit ? null : { root: "/project", name: "project" },
    lightEdit,
    settings: { general },
  } as never);
  uninstall = installCloseGuard(deps);
  await vi.waitFor(() => expect(native.close).toBeDefined());
  const preventDefault = vi.fn();
  await native.close!({ preventDefault });
  return preventDefault;
}

describe("native window close", () => {
  it.each([false, true])("keeps old sessions with missing settings (LightEdit=%s)", async (lightEdit) => {
    const prevented = await close({}, lightEdit);
    expect(prevented).toHaveBeenCalledOnce();
    expect(ipc.commands.closeProject).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
  });

  it.each([1, 2])("closes one of %s windows when opted in", async (windows) => {
    vi.mocked(ipc.commands.windowCloseContext).mockResolvedValue({ quitting: false, windows });
    const prevented = await close({ closeWithoutWelcome: true, closeTabsWithWindow: true });
    expect(prevented).not.toHaveBeenCalled();
    expect(ipc.commands.closeProject).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledOnce();
  });

  it("closes a nonlast window with defaults and keeps its saved tabs", async () => {
    vi.mocked(ipc.commands.windowCloseContext).mockResolvedValue({ quitting: false, windows: 2 });
    const prevented = await close({});
    expect(prevented).not.toHaveBeenCalled();
    expect(ipc.commands.closeProject).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps tabs after cancelling unsaved changes (close window=%s)", async (closeWindow) => {
    const cancel = vi.fn();
    deps.prepareClose = async () => ({ dirty: 1, discard: vi.fn(), commit: vi.fn(), cancel });
    const prevented = await close({ closeWithoutWelcome: closeWindow, closeTabsWithWindow: true });
    expect(prevented).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
    expect(ipc.commands.closeProject).not.toHaveBeenCalled();
  });

  it("keeps tabs when saving fails", async () => {
    deps.prepareClose = async () => ({ dirty: 1, discard: vi.fn(), commit: vi.fn(), cancel: vi.fn() });
    deps.ask = async () => ({ button: "save", checked: false });
    deps.saveAll = async () => {
      throw new Error("disk full");
    };
    const prevented = await close({ closeWithoutWelcome: true, closeTabsWithWindow: true });
    expect(prevented).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
  });

  it("stays open when an untitled buffer's Save As is cancelled", async () => {
    vi.mocked(ipc.commands.windowCloseContext).mockResolvedValue({ quitting: false, windows: 2 });
    vi.mocked(services.maybeEditorService).mockReturnValue({
      forgetSavedTabs: forget,
      keepSavedTabs: keep,
      dirtyDocumentIds: () => [],
      untitledDirtyDocumentIds: () => ["untitled:1"],
      cancelClose: vi.fn(),
    } as never);
    deps.prepareClose = async () => ({ dirty: 1, discard: vi.fn(), commit: vi.fn(), cancel: vi.fn() });
    deps.ask = async () => ({ button: "save", checked: false });
    const prevented = await close({});
    expect(deps.saveAll).toHaveBeenCalledOnce();
    expect(prevented).toHaveBeenCalledOnce();
    expect(ipc.commands.windowGroupCancelClose).toHaveBeenCalled();
  });

  it("restores saved tabs if returning to Welcome fails", async () => {
    vi.mocked(ipc.commands.closeProject).mockRejectedValue(new Error("close failed"));
    const prevented = await close({ closeTabsWithWindow: true });
    expect(prevented).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledOnce();
    expect(keep).toHaveBeenCalledOnce();
    expect(deps.onSaveFailed).toHaveBeenCalledOnce();
  });
});

// A quit can start outside the window (Dock, logout, another window): its prompts are drawn
// inside the window, so it has to come forward before asking.
describe("quitting from outside the window", () => {
  function recordingDeps(button: string) {
    const asked: PromptRequest[] = [];
    const d: CloseDeps = {
      ...deps,
      ask: async (r: PromptRequest) => {
        native.order.push("ask");
        asked.push(r);
        return { button, checked: false };
      },
    };
    return { d, asked };
  }

  beforeEach(() => {
    native.order = [];
    vi.spyOn(ipc.commands, "appQuit").mockResolvedValue(undefined);
  });

  it("raises the window before asking to confirm the quit", async () => {
    useProject.setState({
      project: { root: "/project", name: "project" },
      lightEdit: false,
      settings: { general: { confirmExit: true } },
    } as never);
    const { d, asked } = recordingDeps("exit");
    await quitApp(d);
    expect(asked).toHaveLength(1);
    expect(native.order).toEqual(["unminimize", "show", "setFocus", "ask"]);
    expect(ipc.commands.appQuit).toHaveBeenCalledOnce();
  });

  it("does not touch the window when the confirmation is off", async () => {
    useProject.setState({
      project: { root: "/project", name: "project" },
      lightEdit: false,
      settings: { general: { confirmExit: false } },
    } as never);
    const { d } = recordingDeps("exit");
    await quitApp(d);
    expect(native.order).toEqual([]);
    expect(ipc.commands.appQuit).toHaveBeenCalledOnce();
  });

  it("leaves a window with nothing to ask where it is while the app quits", async () => {
    vi.mocked(ipc.commands.windowCloseContext).mockResolvedValue({ quitting: true, windows: 2 });
    deps.runningProcesses = async () => [];
    const { d, asked } = recordingDeps("cancel");
    useProject.setState({
      project: { root: "/project", name: "project" },
      lightEdit: false,
      settings: { general: {} },
    } as never);
    uninstall = installCloseGuard(d);
    await vi.waitFor(() => expect(native.close).toBeDefined());
    await native.close!({ preventDefault: vi.fn() });
    expect(asked).toEqual([]);
    expect(native.order).toEqual([]);
  });

  it("raises each window before the prompts a quit makes it show", async () => {
    vi.mocked(ipc.commands.windowCloseContext).mockResolvedValue({ quitting: true, windows: 2 });
    deps.runningProcesses = async () => ["server.js"];
    const { d } = recordingDeps("cancel");
    useProject.setState({
      project: { root: "/project", name: "project" },
      lightEdit: false,
      settings: { general: {} },
    } as never);
    uninstall = installCloseGuard(d);
    await vi.waitFor(() => expect(native.close).toBeDefined());
    await native.close!({ preventDefault: vi.fn() });
    expect(native.order.slice(0, 4)).toEqual(["unminimize", "show", "setFocus", "ask"]);
    expect(ipc.commands.appCancelQuit).toHaveBeenCalledOnce();
  });
});
