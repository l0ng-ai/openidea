import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttachableProcess, ProjectInfo } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({ discover: vi.fn(), generic: vi.fn(), start: vi.fn(), install: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      debugUnityProcesses: mocks.discover,
      debugAttachableProcesses: mocks.generic,
    },
  };
});
vi.mock("../state", async (original) => ({
  ...(await original<typeof import("../state")>()),
  startSession: mocks.start,
}));

import { registerAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { openAttachPopup, installAttachAdapter } from "../attachPopup";
import { DebuggerOverlays } from "../ui/Overlays";
import { useOverlays } from "../ui/popoverStore";

const editor: AttachableProcess = {
  pid: 42,
  name: "Unity Editor",
  commandLine: "/game",
  adapter: "unity",
  kind: "unity",
  host: null,
  port: null,
};
const ok = (data: AttachableProcess[]) => ({ status: "ok" as const, data });
function deferred() {
  let resolve!: (result: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: { root: "/game" } as ProjectInfo });
  useOverlays.setState({ attach: null });
  mocks.discover.mockResolvedValue(ok([editor]));
  mocks.start.mockResolvedValue(1);
  mocks.install.mockResolvedValue(undefined);
  dispose = registerAction({ id: "tools.install", title: "Install", run: mocks.install });
});
afterEach(() => {
  cleanup();
  dispose();
  useOverlays.setState({ attach: null });
  useProject.setState({ project: null });
});

it("selects a Unity process and starts a non-rerunnable attach session", async () => {
  await openAttachPopup("unity");
  render(<DebuggerOverlays />);
  expect(screen.getByRole("dialog", { name: "Attach to Unity Process" })).toBeTruthy();
  expect(screen.getByText(/switch to Debug Mode/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Attach" }));
  await waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "attach",
        adapter: "unity",
        cwd: "/game",
        extraJson: expect.stringContaining("Unity Editor (42)"),
      }),
      { rerunnable: false },
    ),
  );
  expect(mocks.generic).not.toHaveBeenCalled();
  expect(useOverlays.getState().attach).toBeNull();
});

it("offers installation for a missing adapter and retries discovery afterwards", async () => {
  mocks.discover.mockResolvedValueOnce({
    status: "error",
    error: { kind: "unavailable", message: "debug adapter `unity` not found" },
  });
  await openAttachPopup("unity");
  render(<DebuggerOverlays />);
  fireEvent.click(screen.getByRole("button", { name: "Install Unity Debugger" }));
  await waitFor(() => expect(useOverlays.getState().attach?.processes).toEqual([editor]));
  expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ arg: "unity-debug" }));
});

it("does not replace a refreshed picker with an older discovery response", async () => {
  const old = deferred();
  mocks.discover.mockReturnValueOnce(old.promise);
  const first = openAttachPopup("unity");
  await openAttachPopup("unity");
  old.resolve(ok([]));
  await first;
  expect(useOverlays.getState().attach?.processes).toEqual([editor]);
});

it("does not reopen a cancelled picker when discovery finishes", async () => {
  const pending = deferred();
  mocks.discover.mockReturnValueOnce(pending.promise);
  const request = openAttachPopup("unity");
  useOverlays.setState({ attach: null });
  pending.resolve(ok([editor]));
  await request;
  expect(useOverlays.getState().attach).toBeNull();
});

it("does not attach to an old project's process or retry installation after switching projects", async () => {
  await openAttachPopup("unity");
  render(<DebuggerOverlays />);
  act(() => useProject.setState({ project: { root: "/other" } as ProjectInfo }));
  fireEvent.click(screen.getByRole("button", { name: "Attach" }));
  expect(mocks.start).not.toHaveBeenCalled();
  act(() =>
    useOverlays.setState({
      attach: { processes: [], error: "missing", mode: "unity", projectRoot: "/game", installTool: "unity-debug" },
    }),
  );
  await installAttachAdapter();
  expect(mocks.discover).toHaveBeenCalledTimes(1);
});
