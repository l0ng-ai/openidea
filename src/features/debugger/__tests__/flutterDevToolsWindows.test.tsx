import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const devtoolsUrl = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());
const remote = vi.hoisted(() => ({ on: false }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, flutterDevtoolsUrl: devtoolsUrl, fsReadText: readText } };
});
vi.mock("@/platform/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/remote")>()),
  isRemoteWindow: () => remote.on,
}));

import { emitLocalIdeEvent } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { useContributions } from "@/workbench/contributions";
import { useFlutterDevices } from "@/workbench/flutterDevices";
import { DEVTOOLS_WINDOWS, devToolsUrl, refreshDevTools, registerDevToolsWindows } from "../flutter/devTools";
import { useDebug, type DebugSession } from "../state";
import { FlutterDevToolsTabs, FlutterDevToolsView } from "../ui/FlutterDevTools";

const server = "http://127.0.0.1:9100";
const look = { theme: "dark" as const, background: "1e1f22" };
const windowOf = (id: string) => DEVTOOLS_WINDOWS.find((w) => w.id === id)!;

function session(id: number, extra: Partial<DebugSession>): DebugSession {
  return { id, name: `s${id}`, adapter: "dart", parent: null, status: "running", ...extra } as unknown as DebugSession;
}

function setSessions(...list: DebugSession[]) {
  act(() =>
    useDebug.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) as Record<number, DebugSession> }),
  );
}

const frames = () => [...document.querySelectorAll("iframe")];
const uriOf = (f: HTMLIFrameElement) => new URL(f.src).searchParams.get("uri");

describe("Flutter DevTools windows", () => {
  beforeEach(() => {
    devtoolsUrl.mockReset();
    devtoolsUrl.mockResolvedValue({ status: "ok", data: server });
    useDebug.setState({ sessions: {}, active: null });
    remote.on = false;
  });
  afterEach(cleanup);

  it("asks for the pages Android Studio shows", () => {
    const query = (id: string) => {
      const url = new URL(devToolsUrl(server, windowOf(id), { uri: "ws://a", embedded: look }));
      return [url.pathname, url.searchParams.get("embedMode"), url.searchParams.get("hide")];
    };
    expect(query("flutter-inspector")).toEqual(["/inspector", "one", null]);
    expect(query("flutter-deep-links")).toEqual(["/deep-links", "one", null]);
    expect(query("flutter-devtools")).toEqual(["/", "many", "home,inspector,deep-links,extensions,debugger"]);
    expect(query("flutter-devtools-extensions")).toEqual(["/", "many", "all-except-extensions"]);
    const url = new URL(devToolsUrl(server, windowOf("flutter-inspector"), { embedded: look }));
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("backgroundColor")).toBe("1e1f22");
    expect(url.searchParams.has("uri")).toBe(false);
  });

  it("exists in Flutter projects, run configurations or not", async () => {
    const ids = () => [...useContributions.getState().toolWindows.keys()];
    const pubspecs: Record<string, string> = {
      "/app/pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "/tool/pubspec.yaml": "name: tool\ndependencies:\n  args: ^2.0.0\n",
    };
    readText.mockImplementation(async (path: string) =>
      path in pubspecs ? { status: "ok", data: pubspecs[path] } : { status: "error", error: { kind: "notFound" } },
    );
    useProject.setState({ project: { root: "/app" } as never });
    const dispose = registerDevToolsWindows();
    await waitFor(() => expect(ids()).toEqual(expect.arrayContaining(DEVTOOLS_WINDOWS.map((w) => w.id))));
    expect(getContext().flutterDevTools).toBe(true);

    useProject.setState({ project: { root: "/tool" } as never });
    await waitFor(() => expect(ids()).not.toContain("flutter-inspector"));
    expect(getContext().flutterDevTools).toBe(false);

    // Adding the SDK dependency later brings the windows.
    pubspecs["/tool/pubspec.yaml"] += "  flutter:\n    sdk: flutter\n";
    act(() => emitLocalIdeEvent({ type: "fsChanged", created: [], modified: ["/tool/pubspec.yaml"], removed: [] }));
    await waitFor(() => expect(ids()).toContain("flutter-inspector"));

    useProject.setState({ project: { root: "/empty" } as never });
    await waitFor(() => expect(ids()).not.toContain("flutter-inspector"));
    dispose();
    useProject.setState({ project: null });
  });

  it("starts no server for a remote window", async () => {
    remote.on = true;
    render(<FlutterDevToolsView id="flutter-inspector" />);
    await screen.findByText("Flutter DevTools isn't available in a remote project yet");
    expect(devtoolsUrl).not.toHaveBeenCalled();
  });

  it("gives the Inspector one page per running app", async () => {
    render(
      <>
        <FlutterDevToolsTabs />
        <FlutterDevToolsView id="flutter-inspector" />
      </>,
    );
    await screen.findByText("No running applications");
    expect(frames()).toHaveLength(0);

    useFlutterDevices.setState({
      list: { status: { kind: "ready" }, devices: [{ id: "d1", name: "Pixel" }] } as never,
    });
    const first = session(1, { vmServiceUri: "ws://one", flutterDevice: "d1" });
    const second = session(2, { vmServiceUri: "ws://two", flutterDevice: "macos" });
    setSessions(first, second, session(3, {}));
    await waitFor(() => expect(frames()).toHaveLength(2));
    expect(frames().map(uriOf)).toEqual(["ws://one", "ws://two"]);
    expect(frames().map((f) => f.hidden)).toEqual([true, false]);
    expect(screen.getByText("Pixel")).toBeTruthy();
    expect(screen.getByText("macos")).toBeTruthy();

    setSessions(
      { ...first, status: "terminated" } as DebugSession,
      { ...second, status: "terminated" } as DebugSession,
    );
    await screen.findByText("No running applications");
  });

  it("keeps the other pages on the latest app and loads them without one", async () => {
    render(<FlutterDevToolsView id="flutter-devtools" />);
    await waitFor(() => expect(frames()).toHaveLength(1));
    expect(uriOf(frames()[0]!)).toBeNull();
    setSessions(
      session(1, { vmServiceUri: "ws://one" }),
      session(2, { vmServiceUri: "ws://two", status: "terminated" } as never),
    );
    await waitFor(() => expect(uriOf(frames()[0]!)).toBe("ws://two"));
  });

  it("shows why the server is missing and asks again only on Refresh", async () => {
    devtoolsUrl.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "boom" } });
    render(<FlutterDevToolsView id="flutter-deep-links" />);
    await screen.findByText(/boom/);
    expect(devtoolsUrl).toHaveBeenCalledTimes(1);
    devtoolsUrl.mockResolvedValue({ status: "ok", data: server });
    act(() => refreshDevTools("flutter-deep-links"));
    await waitFor(() => expect(frames()).toHaveLength(1));
    expect(devtoolsUrl).toHaveBeenCalledTimes(2);
    expect(new URL(frames()[0]!.src).pathname).toBe("/deep-links");
  });
});
