import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import { downloadTo, downloadToProject, ensureRoot } from "./remoteHost";
import { useDeployment } from "./store";

const ipc = vi.hoisted(() => ({
  root: vi.fn(),
  list: vi.fn(),
  download: vi.fn(),
  downloadInto: vi.fn(),
  notify: vi.fn(),
  openDialog: vi.fn(),
  fsEntryKind: vi.fn(),
  selection: vi.fn(() => ["/project/src"] as string[]),
}));
vi.mock("./actions", () => ({ downloadPaths: ipc.download, downloadRemoteInto: ipc.downloadInto }));
vi.mock("./ssh", () => ({ withSsh: (_: string, run: () => unknown) => run() }));
vi.mock("@/ui", () => ({ copyText: vi.fn() }));
vi.mock("@/workbench/inputDialogs", () => ({ promptInput: vi.fn() }));
vi.mock("@/workbench/messages", () => ({ confirm: vi.fn() }));
vi.mock("@/platform/dialog", () => ({ open: (...args: unknown[]) => ipc.openDialog(...args) }));
vi.mock("@/platform/project", () => ({ useProject: { getState: () => ({ project: { root: "/project" } }) } }));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: ipc.notify }),
  projectViewSelection: () => ipc.selection(),
  editorService: () => ({ openFile: vi.fn() }),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    deployServerRoot: ipc.root,
    remoteList: ipc.list,
    fsEntryKind: ipc.fsEntryKind,
  },
}));

beforeEach(() => {
  useDeployment.setState({ trees: {} });
  vi.clearAllMocks();
  ipc.root.mockResolvedValue({ status: "ok", data: { root: "/srv", mappings: [] } });
  ipc.list.mockResolvedValue({ status: "ok", data: [] });
  ipc.openDialog.mockResolvedValue("/project/src");
  ipc.fsEntryKind.mockResolvedValue({ status: "ok", data: "dir" });
  ipc.selection.mockReturnValue(["/project/src"]);
});

it("reloads a server's tree when changing its filesystem type or root", async () => {
  const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "existing", sshConfig: "ssh", rootPath: "/srv" };
  await ensureRoot(server);
  expect(ipc.list).toHaveBeenLastCalledWith({ kind: "sftp", ssh: "ssh" }, "/srv");
  await ensureRoot(server);
  expect(ipc.root).toHaveBeenCalledTimes(1);
  const local = { ...server, kind: "local" as const };
  await ensureRoot(local);
  expect(ipc.list).toHaveBeenLastCalledWith({ kind: "local" }, "/srv");
  ipc.root.mockResolvedValue({ status: "ok", data: { root: "/mounted", mappings: [] } });
  await ensureRoot({ ...local, rootPath: "/mounted" });
  expect(ipc.list).toHaveBeenLastCalledWith({ kind: "local" }, "/mounted");
  expect(useDeployment.getState().trees.existing?.root).toBe("/mounted");
});

it("refreshes resolved mappings when the local mapping changes", async () => {
  const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "local", kind: "local" as const };
  await ensureRoot(server);
  const mappings = [{ local: "/project/src", deployment: "/srv" }];
  ipc.root.mockResolvedValue({ status: "ok", data: { root: "/srv", mappings } });
  await ensureRoot({ ...server, mappings: [{ local: "/alias", deployment: "/", web: "" }] });
  expect(ipc.root).toHaveBeenCalledTimes(2);
  expect(useDeployment.getState().trees.local?.mappings).toEqual(mappings);
});

it("downloads using backend-resolved folders instead of the configured alias", async () => {
  const server = {
    ...DEFAULT_DEPLOYMENT_SERVER,
    id: "local",
    kind: "local" as const,
    mappings: [{ local: "/alias", deployment: ".", web: "" }],
  };
  const mappings = [{ local: "/project/src", deployment: "/srv" }];
  ipc.root.mockResolvedValue({ status: "ok", data: { root: "/srv", mappings } });
  const entry = {
    path: "/srv/a.txt",
    name: "a.txt",
    isDir: false,
    isSymlink: false,
    size: 5,
    mtime: null,
    permissions: "rw-r--r--",
  };
  await downloadToProject(server, [entry]);
  expect(ipc.download).toHaveBeenCalledWith(server, ["/project/src/a.txt"]);
  ipc.download.mockClear();
  ipc.root.mockResolvedValue({ status: "ok", data: { root: "/srv", mappings: [] } });
  await downloadToProject(server, [entry]);
  expect(ipc.download).not.toHaveBeenCalled();
  expect(ipc.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Not mapped to a project path" }));
});

it("Download to… preselects the Project view folder and downloads by remote basename", async () => {
  const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "sftp", sshConfig: "ssh", rootPath: "/home" };
  const entry = {
    path: "/home/user/www/example.ch/current/drush",
    name: "drush",
    isDir: true,
    isSymlink: false,
    size: 0,
    mtime: null,
    permissions: "rwxr-xr-x",
  };
  await downloadTo(server, [entry]);
  expect(ipc.fsEntryKind).toHaveBeenCalledWith("/project/src");
  expect(ipc.openDialog).toHaveBeenCalledWith(
    expect.objectContaining({ directory: true, defaultPath: "/project/src" }),
  );
  expect(ipc.downloadInto).toHaveBeenCalledWith(server, ["/home/user/www/example.ch/current/drush"], "/project/src");

  ipc.openDialog.mockResolvedValueOnce(null);
  await downloadTo(server, [entry]);
  expect(ipc.downloadInto).toHaveBeenCalledTimes(1);

  ipc.selection.mockReturnValueOnce(["/project/src/a.txt"]);
  ipc.fsEntryKind.mockResolvedValueOnce({ status: "ok", data: "file" });
  ipc.openDialog.mockResolvedValueOnce("/chosen");
  await downloadTo(server, [entry]);
  expect(ipc.openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "/project/src" }));
  expect(ipc.downloadInto).toHaveBeenLastCalledWith(server, [entry.path], "/chosen");
});
