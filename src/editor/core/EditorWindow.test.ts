import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorInput } from "@/workbench/contributions";
import { activateEditorWindow } from "./EditorWindow";

const boot = vi.hoisted(() => ({
  emit: vi.fn(async () => {}),
  prepare: vi.fn(async (input: EditorInput) => input),
  openInput: vi.fn(async (_input: EditorInput, _options: unknown) => {}),
  openFile: vi.fn(async () => {}),
  setProject: vi.fn(),
  takeLaunch: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: boot.emit }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "editor-main-3",
    onCloseRequested: async () => () => {},
    setTitle: async () => {},
  }),
}));
vi.mock("@/platform/ipc", () => ({
  commands: {
    windowTakeLaunch: boot.takeLaunch,
    projectCurrent: async () => ({ name: "Project", root: "/project", settings: {} }),
  },
}));
vi.mock("@/platform/context", () => ({ setContext: vi.fn() }));
vi.mock("@/platform/project", () => ({ basename: (path: string) => path, useProject: { setState: boot.setProject } }));
vi.mock("@/platform/remote", () => ({ restoreRemote: async () => {} }));
vi.mock("@/platform/platformInfo", () => ({ usePlatform: vi.fn() }));
vi.mock("@/ui", () => ({ Spinner: () => null, T: () => null, isPopupOpen: () => false }));
vi.mock("@/workbench/contributions", () => ({
  editorService: () => ({ openInput: boot.openInput, openFile: boot.openFile }),
  notifications: () => ({ notify: vi.fn() }),
  useContributions: {
    getState: () => ({ editorKinds: new Map([["agent-session", { prepareWindowInput: boot.prepare }]]) }),
  },
}));
vi.mock("@/workbench/EditorArea", () => ({ EditorArea: () => null }));
vi.mock("@/workbench/OverlayHost", () => ({ OverlayHost: () => null }));
vi.mock("@/workbench/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("@/workbench/WindowResizeHandles", () => ({ WindowResizeHandles: () => null }));
vi.mock("@/workbench/theme", () => ({ useApplyTheme: () => {} }));
vi.mock("@/workbench/messages", () => ({ ask: vi.fn() }));
vi.mock("./controller", () => ({ editorController: vi.fn(), tabTitle: () => "Conversation" }));

let stop: (() => void) | undefined;
const input: EditorInput = { kind: "agent-session", key: "agent:one", data: { task: "one" } };
beforeEach(() => {
  vi.clearAllMocks();
  boot.takeLaunch.mockResolvedValue({ editor: { input: JSON.stringify(input) } });
});
afterEach(() => stop?.());

describe("lightweight window handoff", () => {
  it("opens and reports ready only after its kind prepared the input", async () => {
    let ready!: (input: EditorInput) => void;
    boot.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    stop = activateEditorWindow("main");
    await vi.waitFor(() => expect(boot.prepare).toHaveBeenCalledWith(input));
    expect(boot.openInput).not.toHaveBeenCalled();
    expect(boot.emit).not.toHaveBeenCalled();
    const recovered = { ...input, data: { task: "one", draft: { text: "Latest draft" } } };
    ready(recovered);
    await vi.waitFor(() =>
      expect(boot.emit).toHaveBeenCalledWith("main", "openidea://editor/ready", {
        label: "editor-main-3",
        path: input.key,
        ok: true,
      }),
    );
    expect(boot.openInput).toHaveBeenCalledWith(recovered, { focus: true });
  });

  it("reports failure without opening a broken conversation", async () => {
    boot.prepare.mockRejectedValueOnce(new Error("Cannot load conversation"));
    stop = activateEditorWindow("main");
    await vi.waitFor(() =>
      expect(boot.emit).toHaveBeenCalledWith("main", "openidea://editor/ready", {
        label: "editor-main-3",
        path: input.key,
        ok: false,
        error: "Error: Cannot load conversation",
      }),
    );
    expect(boot.openInput).not.toHaveBeenCalled();
  });
});
