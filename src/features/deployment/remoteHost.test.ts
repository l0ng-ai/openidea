import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import { ensureRoot } from "./remoteHost";
import { useDeployment } from "./store";

const ipc = vi.hoisted(() => ({ root: vi.fn(), list: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { deployServerRoot: ipc.root, remoteList: ipc.list },
}));

beforeEach(() => {
  useDeployment.setState({ trees: {} });
  vi.clearAllMocks();
  ipc.root.mockResolvedValue({ status: "ok", data: "/srv" });
  ipc.list.mockResolvedValue({ status: "ok", data: [] });
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
  ipc.root.mockResolvedValue({ status: "ok", data: "/mounted" });
  await ensureRoot({ ...local, rootPath: "/mounted" });
  expect(ipc.list).toHaveBeenLastCalledWith({ kind: "local" }, "/mounted");
  expect(useDeployment.getState().trees.existing?.root).toBe("/mounted");
});
