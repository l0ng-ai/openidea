import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { useDeployment } from "./store";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  project: vi.fn(),
  open: vi.fn(),
  cancel: vi.fn(),
  ask: vi.fn(),
  error: vi.fn(),
  dirty: vi.fn(),
  save: vi.fn(),
  dispose: vi.fn(),
  destroy: vi.fn(),
  close: vi.fn(),
  title: vi.fn(),
  closeRequested: null as null | ((event: { preventDefault(): void }) => Promise<void>),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "deployment-project-2",
    listen: async () => () => {},
    onCloseRequested: async (callback: typeof mocks.closeRequested) => {
      mocks.closeRequested = callback;
      return () => {};
    },
    setTitle: mocks.title,
    close: mocks.close,
    destroy: mocks.destroy,
  }),
}));
vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  commands: { windowTakeLaunch: mocks.launch, projectCurrent: mocks.project },
}));
vi.mock("@/features/app/locale", () => ({ installLocaleSync: () => () => {} }));
vi.mock("@/features/settings/runtime", () => ({ trackRuntimeSettings: () => () => {} }));
vi.mock("@/editor/core/embeddedDocuments", () => ({
  activateEmbeddedDocuments: () => ({ dirty: mocks.dirty, save: mocks.save, dispose: mocks.dispose }),
}));
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask, showError: mocks.error }));
vi.mock("./actions", () => ({ openSync: mocks.open, closeSync: mocks.cancel }));
vi.mock("./windowBridge", () => ({ deploymentWindowParent: () => "project-2", openDeploymentSource: vi.fn() }));
vi.mock("./Dialogs", () => ({ SecretDialog: () => null }));
vi.mock("./SyncDialog", () => ({ SyncDialog: () => null }));
vi.mock("@/workbench/OverlayHost", () => ({ OverlayHost: () => null }));
vi.mock("@/workbench/TitleBar", () => ({ TitleBar: () => null }));

import { activateDeploymentWindow } from "./window";

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.launch.mockResolvedValue(null);
  mocks.dirty.mockReturnValue(false);
  mocks.save.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.ask.mockResolvedValue({ button: "cancel" });
  useProject.setState({ project: null, settings: { files: { autoSave: false } } as never });
  useDeployment.setState({ sync: null });
});
afterEach(() => {
  stop?.();
  stop = undefined;
});

it("loads the parent project before comparing the launched server and local selection", async () => {
  const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "s2", name: "Second project" };
  const project = { root: "/second", settings: { deployment: { servers: [server] } } };
  mocks.project.mockResolvedValue(project);
  mocks.launch.mockResolvedValueOnce({ deployment: { server: "s2", paths: ["/second/a.php"] } });
  mocks.open.mockImplementation(async () => useDeployment.setState({ sync: { server: "s2" } as never }));
  stop = activateDeploymentWindow();
  await vi.waitFor(() =>
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), ["/second/a.php"]),
  );
  expect(useProject.getState().project).toBe(project);
});

it("keeps the window and unsaved local edits when closing is cancelled or saving fails", async () => {
  mocks.dirty.mockReturnValue(true);
  stop = activateDeploymentWindow();
  const event = { preventDefault: vi.fn() };
  await mocks.closeRequested!(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.destroy).not.toHaveBeenCalled();
  mocks.ask.mockResolvedValue({ button: "save" });
  mocks.save.mockRejectedValueOnce(new Error("Disk full"));
  await mocks.closeRequested!(event);
  expect(mocks.error).toHaveBeenCalledWith("Cannot close deployment comparison", "Disk full");
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(mocks.destroy).not.toHaveBeenCalled();
  await mocks.closeRequested!(event);
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.save.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.destroy.mock.invocationCallOrder[0]!);
});
