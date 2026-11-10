import { beforeEach, expect, it, vi } from "vitest";
import { IpcError } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";

const mocks = vi.hoisted(() => ({ open: vi.fn(), notify: vi.fn() }));
vi.mock("@/workbench/projectWindow", () => ({ openRemoteProject: mocks.open }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));

import { reopenInContainer } from "./container";

const project = (root: string) => ({ root, name: "app", trusted: true }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  useRemote.setState({ session: null });
  useProject.setState({ project: project("/Users/me/app") });
});

it("opens the local project's dev container", async () => {
  mocks.open.mockResolvedValue(true);
  await reopenInContainer();
  expect(mocks.open).toHaveBeenCalledWith(
    { kind: "devContainer", folder: "/Users/me/app", config: "" },
    "/Users/me/app",
  );
  expect(mocks.notify).not.toHaveBeenCalled();
});

it("does nothing in a remote window or without a project", async () => {
  useRemote.setState({
    session: { target: { kind: "ssh", config: "a" }, root: "/srv/app", host: "a", os: "linux", commands: [] },
  });
  await reopenInContainer();
  useRemote.setState({ session: null });
  useProject.setState({ project: null });
  await reopenInContainer();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("reports why the container could not be opened, but not a cancel", async () => {
  mocks.open.mockRejectedValueOnce(new Error("The Dev Containers CLI is not installed."));
  await reopenInContainer();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", body: "The Dev Containers CLI is not installed." }),
  );
  mocks.notify.mockClear();
  mocks.open.mockRejectedValueOnce(new IpcError({ kind: "cancelled", message: "Project opening cancelled" }));
  await reopenInContainer();
  expect(mocks.notify).not.toHaveBeenCalled();
});
