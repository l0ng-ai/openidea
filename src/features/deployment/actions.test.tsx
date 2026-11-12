import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentServerValid } from "@/platform/remoteSettings";
import type { SyncEntry } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({
  actions: [] as { id: string; run: (context: { arg: string[] }) => unknown }[],
  servers: [] as DeploymentServerValid[],
  coverage: [] as { server: string; paths: string[]; skipped: { path: string; message: string }[] }[],
  choose: vi.fn(),
  notify: vi.fn(),
  upload: vi.fn(),
  compare: vi.fn(),
  sync: vi.fn(),
  save: vi.fn(),
  release: vi.fn(),
  attachedPaths: [] as string[],
  desktop: false,
  openWindow: vi.fn(),
}));
vi.mock("./windowBridge", () => ({ showDeploymentComparison: mocks.openWindow }));
vi.mock("@/editor/api", () => ({
  editorsFor: (path: string) => (mocks.attachedPaths.includes(path) ? [{}] : []),
  attachDocument: async () => ({ save: mocks.save, release: mocks.release }),
}));
vi.mock("@/platform/actions", () => ({
  executeAction: vi.fn(),
  registerActions: (actions: typeof mocks.actions) => {
    mocks.actions = actions;
    return () => {};
  },
}));
vi.mock("@/workbench/messages", () => ({ confirm: vi.fn() }));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/platform/context", () => ({ getContext: () => ({}) }));
vi.mock("@/platform/project", () => ({
  relativePath: (_: string, path: string) => path,
  useProject: { getState: () => ({ project: { root: "/project" } }) },
}));
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ deployment: { servers: mocks.servers, defaultServer: "one" } }),
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: mocks.notify }),
  projectViewSelection: () => [],
  toolWindowService: vi.fn(),
}));
vi.mock("@/workbench/inputDialogs", () => ({ chooseItem: mocks.choose }));
vi.mock("./ssh", () => ({ withSsh: (_: unknown, run: () => unknown) => run() }));
vi.mock("@/platform/ipc", () => ({
  call: (value: unknown) => value,
  nextRequestId: () => 1,
  isCancelled: () => false,
  isTauri: () => mocks.desktop,
  commands: {
    deployCoverage: async () => mocks.coverage,
    deployUpload: mocks.upload,
    deployCompare: mocks.compare,
    deploySync: mocks.sync,
  },
}));
import { registerDeploymentActions, runSync } from "./actions";
import { useDeployment } from "./store";

async function run(id: string, paths = ["/project/a", "/project/b"]) {
  mocks.actions.find((action) => action.id === id)!.run({ arg: paths });
  await vi.waitFor(() =>
    expect(
      mocks.choose.mock.calls.length + mocks.notify.mock.calls.length + (useDeployment.getState().sync ? 1 : 0),
    ).toBeGreaterThan(0),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.servers = ["one", "two"].map((id) => ({ id, name: id, kind: "local" }) as DeploymentServerValid);
  mocks.coverage = [
    {
      server: "one",
      paths: ["/project/a"],
      skipped: [{ path: "/project/b", message: "Not covered by this server's mappings" }],
    },
    { server: "two", paths: [], skipped: [] },
  ];
  mocks.choose.mockResolvedValue(null);
  mocks.upload.mockResolvedValue({ files: 1, skipped: 1, errors: [] });
  mocks.compare.mockResolvedValue([]);
  mocks.sync.mockResolvedValue({ files: 1, skipped: 0, errors: [] });
  mocks.save.mockResolvedValue(undefined);
  mocks.attachedPaths = [];
  mocks.desktop = false;
  mocks.openWindow.mockResolvedValue(undefined);
  useDeployment.setState({ sync: null });
  registerDeploymentActions();
});
describe("deployment eligibility", () => {
  it("keeps upstream's server-specific explanation when only one server is configured", async () => {
    mocks.servers = [mocks.servers[0]!];
    mocks.coverage[0]!.paths = [];
    await run("deployment.uploadTo");
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "No selected paths can be deployed to one" }),
    );
    expect(mocks.notify.mock.calls[0]![0].body.props.report.errors).toEqual(mocks.coverage[0]!.skipped);
  });
  it("opens the selected server and paths in a native window on desktop without an in-page comparison", async () => {
    mocks.desktop = true;
    mocks.choose.mockResolvedValue("one");
    await run("deployment.syncWith");
    await vi.waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("one", ["/project/a", "/project/b"]));
    expect(useDeployment.getState().sync).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("opens default-server synchronization in a native window on desktop too", async () => {
    mocks.desktop = true;
    // The default server needs no choice, and on desktop nothing opens in the page.
    mocks.actions
      .find((action) => action.id === "deployment.syncWithDefault")!
      .run({ arg: ["/project/a", "/project/b"] });
    await vi.waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("one", ["/project/a", "/project/b"]));
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(useDeployment.getState().sync).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it.each(["deployment.syncWith", "deployment.syncWithDefault"])(
    "reports a comparison window that cannot open (%s)",
    async (action) => {
      mocks.desktop = true;
      mocks.choose.mockResolvedValue("one");
      mocks.openWindow.mockRejectedValueOnce(new Error("window failed"));
      await run(action);
      await vi.waitFor(() =>
        expect(mocks.notify).toHaveBeenCalledWith(
          expect.objectContaining({ title: expect.stringContaining("Cannot open comparison") }),
        ),
      );
      expect(useDeployment.getState().sync).toBeNull();
    },
  );
  it("saves edits made in the local diff before synchronization and stops if saving fails", async () => {
    await run("deployment.syncWith");
    mocks.choose.mockResolvedValue("one");
    await run("deployment.syncWith");
    await vi.waitFor(() => expect(useDeployment.getState().sync?.entries).toEqual([]));
    const sync = useDeployment.getState().sync!;
    mocks.attachedPaths = ["/project/a"];
    await runSync([
      { path: "a", action: "upload" },
      { path: "b", action: "download" },
    ]);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.sync.mock.invocationCallOrder[0]!);
    useDeployment.setState({ sync });
    mocks.sync.mockClear();
    mocks.save.mockRejectedValueOnce(new Error("Cannot save local file"));
    await runSync([{ path: "a", action: "upload" }]);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(useDeployment.getState().sync?.error).toBe("Cannot save local file");
  });
  it.each(["deployment.uploadTo", "deployment.downloadFrom", "deployment.syncWith"])(
    "filters %s and keeps a single option visible",
    async (id) => {
      await run(id);
      expect(mocks.choose).toHaveBeenCalledWith(expect.objectContaining({ items: ["one"] }));
    },
  );
  it.each(["deployment.uploadTo", "deployment.downloadFrom", "deployment.syncWith"])(
    "explains the rejected paths for %s and links settings",
    async (id) => {
      mocks.coverage[0]!.paths = [];
      await run(id);
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No deployment server covers the selected paths",
          actions: [expect.objectContaining({ label: "Configure…" })],
        }),
      );
      expect(mocks.notify.mock.calls[0]![0].body.props.report.errors).toEqual([
        { path: "/project/b", message: "one: Not covered by this server's mappings" },
      ]);
      expect(mocks.compare).not.toHaveBeenCalled();
    },
  );
  it("explains why the default cannot deploy the named file", async () => {
    mocks.coverage[0]!.paths = [];
    await run("deployment.uploadToDefault");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls[0]![0].body.props.report.errors[0].path).toBe("/project/b");
  });
  it("compares every covered selection and retains skipped paths", async () => {
    mocks.coverage[0]!.paths.push("/project/c");
    mocks.choose.mockResolvedValue("one");
    await run("deployment.syncWith");
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    expect(useDeployment.getState().sync?.skipped?.[0]?.path).toBe("/project/b");
  });
  it("keeps the comparison and other choices after synchronizing a single file, then supports the next file", async () => {
    mocks.choose.mockResolvedValue("one");
    await run("deployment.syncWith");
    await vi.waitFor(() => expect(useDeployment.getState().sync?.entries).toEqual([]));
    const entries: SyncEntry[] = ["a", "b"].map((path) => ({
      path,
      remotePath: `/remote/${path}`,
      local: { size: 10, mtime: 2 },
      remote: { size: 5, mtime: 1 },
      status: "localNewer",
    }));
    useDeployment.setState((state) => ({
      sync: { ...state.sync!, entries, choices: { a: "upload", b: "deleteRemote" } },
    }));
    const refreshed = { ...entries[0]!, remote: entries[0]!.local, status: "same" as const };
    mocks.compare.mockResolvedValueOnce([refreshed]);
    await runSync([{ path: "a", action: "upload" }], "selected");
    expect(mocks.sync).toHaveBeenLastCalledWith([{ path: "a", action: "upload" }], "one", 1);
    expect(mocks.compare).toHaveBeenLastCalledWith("/project/a", "one", 1);
    expect(useDeployment.getState().sync).toMatchObject({
      running: false,
      request: null,
      choices: { a: "skip", b: "deleteRemote" },
      entries: [refreshed, entries[1]],
    });
    mocks.compare.mockResolvedValueOnce([{ ...entries[1]!, remote: null, status: "localOnly" }]);
    await runSync([{ path: "b", action: "deleteRemote" }], "selected");
    expect(useDeployment.getState().sync?.choices).toEqual({ a: "skip", b: "skip" });
    expect(useDeployment.getState().sync?.entries).toHaveLength(2);
  });
  it("retains failed selected operations for retry and does not change pending files when refresh fails", async () => {
    mocks.choose.mockResolvedValue("one");
    await run("deployment.syncWith");
    await vi.waitFor(() => expect(useDeployment.getState().sync?.entries).toEqual([]));
    const entries: SyncEntry[] = ["a", "b"].map((path) => ({
      path,
      remotePath: `/remote/${path}`,
      local: { size: 10, mtime: 2 },
      remote: null,
      status: "localOnly",
    }));
    useDeployment.setState((state) => ({ sync: { ...state.sync!, entries, choices: { a: "upload", b: "upload" } } }));
    mocks.sync.mockResolvedValueOnce({ files: 0, skipped: 0, errors: [{ path: "a", message: "Permission denied" }] });
    mocks.compare.mockResolvedValueOnce([entries[0]]);
    await runSync([{ path: "a", action: "upload" }], "selected");
    expect(useDeployment.getState().sync).toMatchObject({
      running: false,
      choices: { a: "upload", b: "upload" },
      error: "a: Permission denied",
    });
    mocks.compare.mockRejectedValueOnce(new Error("Connection lost"));
    await runSync([{ path: "a", action: "upload" }], "selected");
    expect(useDeployment.getState().sync).toMatchObject({
      running: false,
      request: null,
      choices: { a: "skip", b: "upload" },
      entries,
    });
    expect(useDeployment.getState().sync?.error).toContain("Could not refresh comparison: a: Connection lost");
  });
});
