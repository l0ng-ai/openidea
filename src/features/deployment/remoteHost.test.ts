import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import {
  chooseUploadFiles,
  chooseUploadFolder,
  downloadTo,
  downloadToProject,
  ensureRoot,
  uploadLocalInto,
} from "./remoteHost";
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
  upload: vi.fn(),
  report: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("./actions", () => ({
  downloadPaths: ipc.download,
  downloadRemoteInto: ipc.downloadInto,
  showReport: ipc.report,
}));
vi.mock("./ssh", () => ({ withSsh: (_: string, run: () => unknown) => run() }));
vi.mock("@/ui", () => ({ copyText: vi.fn() }));
vi.mock("@/workbench/inputDialogs", () => ({ promptInput: vi.fn() }));
vi.mock("@/workbench/messages", () => ({ confirm: ipc.confirm }));
vi.mock("@/platform/dialog", () => ({ open: (...args: unknown[]) => ipc.openDialog(...args) }));
vi.mock("@/platform/project", () => ({
  useProject: { getState: () => ({ project: { root: "/project" } }), subscribe: vi.fn() },
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: ipc.notify }),
  projectViewSelection: () => ipc.selection(),
  editorService: () => ({ openFile: vi.fn() }),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    deployServerRoot: ipc.root,
    remoteList: ipc.list,
    fsEntryKind: ipc.fsEntryKind,
    remoteUploadInto: ipc.upload,
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
  ipc.upload.mockResolvedValue({ status: "ok", data: { files: 1, skipped: 0, errors: [] } });
  ipc.confirm.mockResolvedValue(false);
});

const uploadServer = { ...DEFAULT_DEPLOYMENT_SERVER, id: "upload", sshConfig: "ssh", rootPath: "/srv", mappings: [] };
const existingFile = {
  name: "a.txt",
  path: "/srv/a.txt",
  isDir: false,
  isSymlink: false,
  size: 3,
  mtime: null,
  permissions: "",
};

it("uploads project-external paths without mappings and refreshes the destination", async () => {
  await ensureRoot(uploadServer);
  ipc.list.mockClear();
  await uploadLocalInto(uploadServer, ["C:/Downloads/a.txt"], "/srv");
  expect(ipc.upload).toHaveBeenCalledWith(
    { kind: "sftp", ssh: "ssh" },
    ["C:/Downloads/a.txt"],
    "/srv",
    false,
    expect.any(Number),
  );
  expect(ipc.confirm).not.toHaveBeenCalled();
  expect(ipc.list).toHaveBeenCalledTimes(2);
  expect(ipc.report).toHaveBeenCalledWith({ files: 1, skipped: 0, errors: [] }, "upload", uploadServer);
});

it("does not write on collision cancellation and enables replacement only after approval", async () => {
  await ensureRoot(uploadServer);
  ipc.list.mockResolvedValue({ status: "ok", data: [existingFile] });
  await uploadLocalInto(uploadServer, ["C:\\Downloads\\a.txt"], "/srv");
  expect(ipc.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace Existing Files?" }));
  expect(ipc.upload).not.toHaveBeenCalled();
  ipc.confirm.mockResolvedValueOnce(true);
  await uploadLocalInto(uploadServer, ["C:\\Downloads\\a.txt"], "/srv");
  expect(ipc.upload).toHaveBeenCalledWith(
    expect.anything(),
    ["C:\\Downloads\\a.txt"],
    "/srv",
    true,
    expect.any(Number),
  );
});

it("refreshes expanded descendants after partial failure or cancellation", async () => {
  await ensureRoot(uploadServer);
  const tree = useDeployment.getState().trees.upload!;
  useDeployment.setState({ trees: { upload: { ...tree, expanded: new Set(["/srv/assets", "/other"]) } } });
  for (const kind of ["cancelled", "io"]) {
    ipc.list.mockClear();
    ipc.upload.mockResolvedValueOnce({ status: "error", error: { kind, message: "upload interrupted" } });
    // oxlint-disable-next-line no-await-in-loop -- each iteration resets the mocks and asserts its own failure path before the next kind runs.
    await uploadLocalInto(uploadServer, ["/outside/a.txt"], "/srv");
    expect(ipc.list.mock.calls.map((call) => call[1])).toEqual(["/srv", "/srv", "/srv/assets"]);
  }
  expect(ipc.notify).toHaveBeenCalledTimes(1);
});

it("Upload Files… sends all selected paths and leaves picker cancellation untouched", async () => {
  ipc.openDialog.mockResolvedValueOnce(["/outside/a.txt", "/outside/b.txt"]);
  await chooseUploadFiles(uploadServer, "/srv");
  expect(ipc.openDialog).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, directory: false }));
  expect(ipc.upload).toHaveBeenCalledWith(
    expect.anything(),
    ["/outside/a.txt", "/outside/b.txt"],
    "/srv",
    false,
    expect.any(Number),
  );
  ipc.openDialog.mockResolvedValueOnce(null);
  await chooseUploadFiles(uploadServer, "/srv");
  expect(ipc.upload).toHaveBeenCalledTimes(1);
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

it("Upload Folder… picks a directory and uploads it under its own name, with cancellation leaving it untouched", async () => {
  ipc.openDialog.mockResolvedValueOnce("/outside/photos");
  await chooseUploadFolder(uploadServer, "/srv/assets");
  expect(ipc.openDialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Upload Folder", directory: true, multiple: false }),
  );
  expect(ipc.upload).toHaveBeenCalledWith(
    expect.anything(),
    ["/outside/photos"],
    "/srv/assets",
    false,
    expect.any(Number),
  );
  ipc.list.mockClear();
  ipc.openDialog.mockResolvedValueOnce(null);
  await chooseUploadFolder(uploadServer, "/srv/assets");
  expect(ipc.upload).toHaveBeenCalledTimes(1);
  expect(ipc.list).not.toHaveBeenCalled();
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
