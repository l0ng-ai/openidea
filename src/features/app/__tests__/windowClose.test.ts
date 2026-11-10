import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/platform/ipc";
import { useProject } from "@/platform/project";
import * as services from "@/workbench/contributions";
import { installCloseGuard, type CloseDeps } from "../closeGuard";

const native = vi.hoisted(() => ({
  close: undefined as ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
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

  it("restores saved tabs if returning to Welcome fails", async () => {
    vi.mocked(ipc.commands.closeProject).mockRejectedValue(new Error("close failed"));
    const prevented = await close({ closeTabsWithWindow: true });
    expect(prevented).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledOnce();
    expect(keep).toHaveBeenCalledOnce();
    expect(deps.onSaveFailed).toHaveBeenCalledOnce();
  });
});
