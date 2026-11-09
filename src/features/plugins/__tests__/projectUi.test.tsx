import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { registerAction } from "@/platform/actions";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { handleRuntimeEvent } from "../runtimeUi";

const nativeOpen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: nativeOpen }));
const answerPrompt = vi.fn().mockResolvedValue(undefined);
let notes: Parameters<NotificationService["notify"]>[0][];
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  dispose = undefined;
  notes = [];
  provideNotificationService({ notify: (note) => void notes.push(note) });
  setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
});
afterEach(() => dispose?.());
const ask = (id: string) =>
  handleRuntimeEvent({
    type: "promptRequested",
    pluginId: "p",
    promptId: id,
    prompt: { kind: "pickDirectory", title: "Clone target", initial: "C:/work" },
  });

describe("project UI requests", () => {
  it("returns an absolute directory as an IPC path using the supplied title and initial path", async () => {
    nativeOpen.mockResolvedValue("C:\\work\\repo");
    ask("directory");
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("directory", ["C:/work/repo"]));
    expect(nativeOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Clone target",
      defaultPath: "C:/work",
    });
  });
  it("reports cancellation and picker errors without leaving the plugin waiting", async () => {
    nativeOpen.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("picker unavailable"));
    ask("cancel");
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("cancel", null));
    ask("failed");
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("failed", null));
    expect(notes).toMatchObject([
      { level: "error", title: "Cannot choose a directory", body: "Error: picker unavailable" },
    ]);
  });
  it("ignores a native result after the host closes its prompt", async () => {
    let finish!: (path: string) => void;
    nativeOpen.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    ask("late");
    await waitFor(() => expect(nativeOpen).toHaveBeenCalled());
    handleRuntimeEvent({ type: "promptClosed", promptId: "late" });
    finish("C:/work/late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answerPrompt).not.toHaveBeenCalled();
  });
  it("routes project opens through the normal window action", async () => {
    const run = vi.fn();
    dispose = registerAction({ id: "file.openProjectPath", title: "Open Project Path", run });
    for (const newWindow of [false, true]) {
      handleRuntimeEvent({ type: "openProject", pluginId: "p", path: "/work/repo", newWindow });
      await waitFor(() =>
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: { path: "/work/repo", newWindow } })),
      );
    }
  });
});

it("acknowledges database connection only after the normal project action succeeds", async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  dispose = registerAction({ id: "db.pluginConnect", title: "Connect Plugin Data Source", run });
  const answerCommand = vi.fn().mockResolvedValue(true);
  setPluginsBackend({ ...createMemoryPluginsBackend(), answerCommand });
  handleRuntimeEvent({
    type: "windowRequest",
    pluginId: "p",
    requestId: "db",
    request: { kind: "databaseConnect", id: "owned" },
  });
  await waitFor(() => expect(answerCommand).toHaveBeenCalledWith("db", { kind: "value", value: null }));
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "owned" }));
  run.mockRejectedValueOnce(new Error("offline"));
  handleRuntimeEvent({
    type: "windowRequest",
    pluginId: "p",
    requestId: "failed",
    request: { kind: "databaseConnect", id: "owned" },
  });
  await waitFor(() =>
    expect(answerCommand).toHaveBeenCalledWith("failed", { kind: "failed", value: "Error: offline" }),
  );
});
