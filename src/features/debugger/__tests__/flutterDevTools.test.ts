import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl: openUrl }));
const remote = vi.hoisted(() => ({ on: false }));
vi.mock("@/platform/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/remote")>()),
  isRemoteWindow: () => remote.on,
}));
const devtoolsUrl = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, flutterDevtoolsUrl: devtoolsUrl } };
});
const openFile = vi.hoisted(() => vi.fn(async () => {}));
const notes = vi.hoisted(() => [] as Array<{ title: string; body?: unknown }>);
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ openFile }),
  notifications: () => ({ notify: (n: (typeof notes)[number]) => void notes.push(n) }),
}));

import { executeAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import type { DebugSessionId } from "@/platform/ipc";
import { registerDebugActions } from "../actions";
import { handleDebugEvent, publishContext, useDebug, type DebugSession } from "../state";

const id = 7 as DebugSessionId;
const uri = "ws://127.0.0.1:5/a=/ws";

describe("Flutter DevTools", () => {
  let dispose = () => {};

  beforeEach(() => {
    dispose();
    dispose = registerDebugActions();
    vi.clearAllMocks();
    notes.length = 0;
    remote.on = false;
    devtoolsUrl.mockResolvedValue({ status: "ok", data: "http://127.0.0.1:9100" });
    const session = { id, name: "app", adapter: "dart", parent: null, status: "running" } as unknown as DebugSession;
    useDebug.setState({ sessions: { [id]: session }, active: id });
    publishContext();
  });

  it("offers DevTools once the session reports its VM Service", () => {
    expect(getContext().debugHasVmService).toBe(false);
    handleDebugEvent(id, { kind: "flutterVmService", uri, device: null });
    publishContext();
    expect(useDebug.getState().sessions[id]?.vmServiceUri).toBe(uri);
    expect(getContext().debugHasVmService).toBe(true);
  });

  it("opens the inspector of the session's app in the browser", async () => {
    handleDebugEvent(id, { kind: "flutterVmService", uri, device: null });
    publishContext();
    await executeAction("debug.openDevTools");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());
    const url = new URL(openUrl.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:9100/inspector");
    expect(url.searchParams.get("uri")).toBe(uri);
  });

  it("reports a server that could not start", async () => {
    devtoolsUrl.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "boom" } });
    handleDebugEvent(id, { kind: "flutterVmService", uri, device: null });
    publishContext();
    await executeAction("debug.openDevTools");
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]).toMatchObject({ title: "Couldn't open Flutter DevTools", body: "boom" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("explains that a remote project has no DevTools", async () => {
    remote.on = true;
    handleDebugEvent(id, { kind: "flutterVmService", uri, device: null });
    publishContext();
    await executeAction("debug.openDevTools");
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    expect(devtoolsUrl).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("shows the widget's source without taking the focus", () => {
    handleDebugEvent(id, { kind: "flutterNavigate", path: "/app/lib/main.dart", line: 2, column: 4 });
    expect(openFile).toHaveBeenCalledWith("/app/lib/main.dart", {
      selection: { line: 2, col: 4 },
      preview: true,
      focus: false,
    });
  });
});
