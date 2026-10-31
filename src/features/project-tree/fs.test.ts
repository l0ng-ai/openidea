import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { invokeLocal } from "@/platform/tauriCore";
import { useTasks } from "@/workbench/tasks";
import { tauriFs } from "./fs";

vi.mock("@/platform/tauriCore", async (original) => ({
  ...(await original<typeof import("@/platform/tauriCore")>()),
  invokeLocal: vi.fn(async () => undefined),
}));

beforeEach(() => {
  useTasks.setState({ tasks: [] });
  useRemote.setState({
    session: { sshConfig: "s", root: "/remote", host: "host", commands: ["fs_copy", "cancel_request"] },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useRemote.setState({ session: null });
  useTasks.setState({ tasks: [] });
});

describe("client file routing", () => {
  it("uploads OS files locally and cancels the client request rather than a remote one", async () => {
    let finish!: (r: { status: "ok"; data: null }) => void;
    const upload = vi.spyOn(commands, "remoteImportLocal").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const copy = vi.spyOn(commands, "fsCopy");
    const work = tauriFs.importLocal("/client/a", "/remote/a");
    const task = useTasks.getState().tasks[0]!;
    const request = upload.mock.calls[0]![2];
    task.cancel!();
    expect(invokeLocal).toHaveBeenCalledWith("cancel_request", { id: request });
    finish({ status: "ok", data: null });
    await work;
    expect(upload).toHaveBeenCalledWith("/client/a", "/remote/a", request);
    expect(copy).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[0]?.done).toBe(true);
  });

  it("surfaces a disconnected upload and finishes its task", async () => {
    vi.spyOn(commands, "remoteImportLocal").mockResolvedValue({
      status: "error",
      error: { kind: "unavailable", message: "Remote project is disconnected" },
    });
    await expect(tauriFs.importLocal("/client/a", "/remote/a")).rejects.toThrow("Remote project is disconnected");
    expect(useTasks.getState().tasks[0]?.done).toBe(true);
  });

  it("uses project copy for a local destination", async () => {
    useRemote.setState({ session: null });
    const copy = vi.spyOn(commands, "fsCopy").mockResolvedValue({ status: "ok", data: null });
    const upload = vi.spyOn(commands, "remoteImportLocal");
    await tauriFs.importLocal("/client/a", "/project/a");
    expect(copy).toHaveBeenCalledWith("/client/a", "/project/a");
    expect(upload).not.toHaveBeenCalled();
  });
});
