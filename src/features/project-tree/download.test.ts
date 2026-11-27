import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress, TransferReport } from "@/bindings";
import { commands } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { invokeLocal } from "@/platform/tauriCore";
import { useTasks } from "@/workbench/tasks";

const open = vi.fn();
vi.mock("@/platform/dialog", () => ({ open: (...args: unknown[]) => open(...args) }));
// `@tauri-apps/api/core` resolves to this module (vite.config.ts).
vi.mock("@/platform/tauriCore", async (orig) => ({
  ...(await orig<typeof import("@/platform/tauriCore")>()),
  invokeLocal: vi.fn(async () => undefined),
  Channel: class {
    onmessage = (_p: unknown) => {};
  },
}));
const notify = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { canDownload, downloadTo } = await import("./download");

const report = (r: Partial<TransferReport>): TransferReport => ({ files: 0, skipped: 0, errors: [], ...r });

beforeEach(() => {
  useTasks.setState({ tasks: [] });
  useRemote.setState({
    session: { target: { kind: "ssh", config: "s" }, root: "/srv/app", host: "box", os: "linux", commands: [] },
  });
  open.mockResolvedValue("/Users/me/Downloads");
});
afterEach(() => {
  vi.restoreAllMocks();
  open.mockReset();
  notify.mockReset();
  useRemote.setState({ session: null });
  useTasks.setState({ tasks: [] });
});

describe("Download to… (#4718)", () => {
  it("is offered only in a remote window", () => {
    expect(canDownload()).toBe(true);
    useRemote.setState({ session: null });
    expect(canDownload()).toBe(false);
  });

  it("downloads the top-level selection into the chosen folder and reports progress", async () => {
    let finish!: (r: { status: "ok"; data: TransferReport }) => void;
    const download = vi.spyOn(commands, "remoteDownloadLocal").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const work = downloadTo(["/srv/app/src", "/srv/app/src/main.rs", "/srv/app/Cargo.toml"]);
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    const [paths, target, request, channel] = download.mock.calls[0]!;
    expect(paths).toEqual(["/srv/app/src", "/srv/app/Cargo.toml"]);
    expect(target).toBe("/Users/me/Downloads");
    (channel as unknown as { onmessage: (p: DownloadProgress) => void }).onmessage({
      path: "/srv/app/src/main.rs",
      done: 1,
      total: 4,
    });
    const task = useTasks.getState().tasks[0]!;
    expect(task).toMatchObject({ title: "Downloading files", message: "main.rs", fraction: 0.25, done: false });
    task.cancel!();
    expect(invokeLocal).toHaveBeenCalledWith("cancel_request", { id: request });
    finish({ status: "ok", data: report({ files: 4 }) });
    await work;
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info", title: "Downloaded 4 files to /Users/me/Downloads" }),
    );
    expect(useTasks.getState().tasks[0]?.done).toBe(true);
  });

  it("lists the files that failed", async () => {
    vi.spyOn(commands, "remoteDownloadLocal").mockResolvedValue({
      status: "ok",
      data: report({ files: 1, errors: [{ path: "/srv/app/link", message: "leads outside the target folder" }] }),
    });
    await downloadTo(["/srv/app"]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        title: "Download to /Users/me/Downloads finished with errors",
        body: "/srv/app/link: leads outside the target folder",
      }),
    );
  });

  it("does nothing when the folder picker is cancelled", async () => {
    open.mockResolvedValue(null);
    const download = vi.spyOn(commands, "remoteDownloadLocal");
    await downloadTo(["/srv/app/a.txt"]);
    expect(download).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks).toEqual([]);
  });

  it("reports a failed download, but not a cancelled one", async () => {
    vi.spyOn(commands, "remoteDownloadLocal").mockResolvedValueOnce({
      status: "error",
      error: { kind: "unavailable", message: "Remote project is disconnected" },
    });
    await downloadTo(["/srv/app/a.txt"]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", body: "Remote project is disconnected" }),
    );
    notify.mockReset();
    vi.spyOn(commands, "remoteDownloadLocal").mockResolvedValueOnce({
      status: "error",
      error: { kind: "cancelled", message: "Cancelled" },
    });
    await downloadTo(["/srv/app/a.txt"]);
    expect(notify).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks.every((t) => t.done)).toBe(true);
  });
});
