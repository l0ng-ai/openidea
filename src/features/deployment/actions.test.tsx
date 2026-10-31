import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentServerValid } from "@/platform/remoteSettings";

const mocks = vi.hoisted(() => ({
  actions: [] as { id: string; run: (context: { arg: string[] }) => unknown }[],
  servers: [] as DeploymentServerValid[],
  coverage: [] as { server: string; paths: string[]; skipped: { path: string; message: string }[] }[],
  choose: vi.fn(),
  notify: vi.fn(),
  upload: vi.fn(),
  compare: vi.fn(),
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
  commands: {
    deployCoverage: async () => mocks.coverage,
    deployUpload: mocks.upload,
    deployCompare: mocks.compare,
  },
}));
import { registerDeploymentActions } from "./actions";
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
  useDeployment.setState({ sync: null });
  registerDeploymentActions();
});
describe("deployment eligibility", () => {
  it.each(["deployment.uploadTo", "deployment.downloadFrom", "deployment.syncWith"])(
    "filters %s and keeps a single option visible",
    async (id) => {
      await run(id);
      expect(mocks.choose).toHaveBeenCalledWith(expect.objectContaining({ items: ["one"] }));
    },
  );
  it("explains an empty match and links settings", async () => {
    mocks.coverage[0]!.paths = [];
    await run("deployment.uploadTo");
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "No deployment server covers the selected paths",
        actions: [expect.objectContaining({ label: "Configure…" })],
      }),
    );
  });
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
});
