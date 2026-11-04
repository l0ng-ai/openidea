import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
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
  exitCode: null,
  caps: null,
};

describe("debug tool window", () => {
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

  it("leaves nothing selected once the last tab is closed", async () => {
    useDebug.setState({ sessions: { 3: { ...session, id: 3, status: "terminated" } }, active: 3 });
    render(<DebugTabs />);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Close Tab" })[0]!));
    expect(useDebug.getState().active).toBeNull();
    expect(useDebug.getState().sessions).toEqual({});
  });
});
