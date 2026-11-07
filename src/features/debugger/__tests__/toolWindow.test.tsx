import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      debugJvmMemoryClasses: () => ok({ status: "unavailable", reason: { kind: "programExited" } }),
      debugScopes: () => ok([{ name: "Locals", variablesReference: 1, expensive: false }]),
      debugVariables: () =>
        ok([
          { name: "count", value: "3", typeName: "int", variablesReference: 0, evaluateName: "count" },
          { name: "label", value: "'hi'", typeName: "str", variablesReference: 0, evaluateName: "label" },
          {
            name: "bar",
            value: "high    7.86\nlow     7.66\nName: 772, dtype: object",
            typeName: "Series",
            variablesReference: 0,
            evaluateName: "bar",
          },
        ]),
    },
  };
});

const confirmTerminate = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/workbench/confirmTerminate", () => ({ confirmTerminate }));

import type { RunConfig } from "@/platform/ipc";
import { useDebug, type DebugSession } from "../state";
import { DebugTabs, DebugToolWindow } from "../ui/DebugToolWindow";

const session: DebugSession = {
  id: 1,
  name: "main",
  adapter: "debugpy",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "MainThread" }],
  selectedThread: 1,
  frames: [{ id: 7, name: "main", path: "/p/app/main.py", line: 11, column: 0, presentationHint: null }],
  selectedFrame: 7,
  hits: 1,
  stops: 0,
  exitCode: null,
  caps: null,
};

describe("debug tool window", () => {
  it("offers Hot Reload and Hot Restart for Dart and Flutter sessions only", () => {
    const hot = () => ["debug.hotReload", "debug.hotRestart"].map((name) => !!screen.queryByRole("button", { name }));
    useDebug.setState({ sessions: { 1: { ...session, status: "running" } }, active: 1 });
    const { unmount } = render(<DebugToolWindow />);
    expect(hot()).toEqual([false, false]);
    unmount();
    useDebug.setState({ sessions: { 1: { ...session, adapter: "dart", status: "running" } }, active: 1 });
    render(<DebugToolWindow />);
    expect(hot()).toEqual([true, true]);
  });

  it("shows the Memory tab only for sessions with jvmMemory", async () => {
    const withCaps = (jvmMemory: boolean) => ({ ...session, caps: { jvmMemory } as DebugSession["caps"] });
    useDebug.setState({ sessions: { 1: withCaps(false) }, active: 1 });
    const { unmount } = render(<DebugToolWindow />);
    expect(screen.queryByRole("tab", { name: "Memory" })).toBeNull();
    unmount();
    useDebug.setState({ sessions: { 1: withCaps(true) }, active: 1 });
    render(<DebugToolWindow />);
    const memory = screen.getByRole("tab", { name: "Memory" });
    fireEvent.click(memory);
    expect(memory.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("The program has exited.")).toBeTruthy();
    // Switching to a session without the capability leaves the tab it no longer has.
    act(() => useDebug.setState({ sessions: { 1: withCaps(false) } }));
    expect(screen.queryByText("The program has exited.")).toBeNull();
    expect(screen.getByRole("tab", { name: "Threads & Variables" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the Memory tab selected when the session pauses", async () => {
    const caps = { jvmMemory: true } as DebugSession["caps"];
    useDebug.setState({ sessions: { 1: { ...session, caps, status: "running" } }, active: 1 });
    render(<DebugToolWindow />);
    const memory = screen.getByRole("tab", { name: "Memory" });
    fireEvent.click(memory);
    expect(await screen.findByText("The program has exited.")).toBeTruthy();
    act(() => useDebug.setState({ sessions: { 1: { ...session, caps, status: "paused" } } }));
    expect(memory.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("The program has exited.")).toBeTruthy();
  });

  it("says a PHP Remote Debug session listens for Xdebug while nothing is suspended", () => {
    const runConfig = {
      id: "php-remote:web",
      name: "web",
      kind: "php-remote",
      command: "",
      args: [],
      cwd: null,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: "php-debug",
      params: { port: "9010" },
    } as RunConfig;
    const waiting = { ...session, adapter: "php-debug", status: "running" as const, threads: [], frames: [] };
    useDebug.setState({ sessions: { 1: { ...waiting, runConfig } }, active: 1 });
    const { unmount } = render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Threads & Variables" }));
    expect(screen.getByText("Listening for Xdebug on port 9010")).toBeTruthy();
    expect(screen.queryByText("Running…")).toBeNull();
    unmount();
    useDebug.setState({ sessions: { 1: waiting }, active: 1 });
    render(<DebugToolWindow />);
    fireEvent.click(screen.getByRole("tab", { name: "Threads & Variables" }));
    expect(screen.getByText("Running…")).toBeTruthy();
  });

  it("shows preparation output, preserves a chosen tab and opens variables on pause", () => {
    useDebug.setState({ sessions: { 1: { ...session, status: "starting" } }, active: 1 });
    render(<DebugToolWindow />);
    const console = screen.getByRole("tab", { name: "Console" });
    const variables = screen.getByRole("tab", { name: "Threads & Variables" });
    expect(console.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(variables);
    expect(variables.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(console);
    act(() => useDebug.setState({ sessions: { 1: { ...session, status: "running" } } }));
    expect(console.getAttribute("aria-selected")).toBe("true");
    act(() => useDebug.setState({ sessions: { 1: session } }));
    expect(variables.getAttribute("aria-selected")).toBe("true");
  });

  it("renders session tabs, views, frames and typed variables", async () => {
    useDebug.setState({ sessions: { 1: session }, active: 1 });
    render(
      <>
        <DebugTabs />
        <DebugToolWindow />
      </>,
    );
    expect(screen.getByRole("tab", { name: /main/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Threads & Variables" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
    expect(screen.getByText(", main.py:12")).toBeTruthy();
    expect(screen.getByPlaceholderText("Evaluate expression (↩) or add a watch (⇧⌘↩)")).toBeTruthy();
    expect(await screen.findByText("{int}")).toBeTruthy();
    expect(screen.getByText("'hi'")).toBeTruthy();
    // A multi-line rendering stays on its row.
    expect(screen.getByText(/dtype: object/).textContent).toBe("high    7.86 low     7.66 Name: 772, dtype: object");
  });

  it("closes a session tab and moves the selection to the one left", async () => {
    useDebug.setState({
      sessions: {
        1: { ...session, status: "terminated" },
        2: { ...session, id: 2, name: "app", status: "terminated" },
      },
      active: 1,
    });
    render(<DebugTabs />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Close Tab" })[0]!));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["app"]);
    expect(useDebug.getState().active).toBe(2);
    expect(useDebug.getState().sessions).not.toHaveProperty("1");
  });

  it("passes the selection of a closed tab to the tab on its left", async () => {
    useDebug.setState({
      sessions: {
        4: { ...session, id: 4, name: "a", status: "terminated" },
        5: { ...session, id: 5, name: "b", status: "terminated" },
        6: { ...session, id: 6, name: "c", status: "terminated" },
      },
      active: 5,
    });
    render(<DebugTabs />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Close Tab" })[1]!));
    expect(useDebug.getState().active).toBe(4);
  });

  it("keeps a live session when the user doesn't terminate it", async () => {
    useDebug.setState({ sessions: { 8: { ...session, id: 8, name: "server" } }, active: 8 });
    render(<DebugTabs />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Close Tab" })[0]!));
    expect(confirmTerminate).toHaveBeenCalledWith("server");
    expect(useDebug.getState().sessions).toHaveProperty("8");
  });

  it("leaves nothing selected once the last tab is closed", async () => {
    useDebug.setState({ sessions: { 3: { ...session, id: 3, status: "terminated" } }, active: 3 });
    render(<DebugTabs />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Close Tab" })[0]!));
    expect(useDebug.getState().active).toBeNull();
    expect(useDebug.getState().sessions).toEqual({});
  });
});
