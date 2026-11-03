import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { adoptSession, appendConsole, useDebug } from "../state";
import { DebugConsole, DebugServiceConsole } from "../ui/DebugConsole";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 18 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

beforeEach(() => useDebug.setState({ sessions: {}, console: {}, active: null }));

it("shows the requested session without changing or following the active debugger", () => {
  adoptSession(1, { name: "one" });
  adoptSession(2, { name: "two" });
  appendConsole(1, "stdout", "service one\n");
  appendConsole(2, "stdout", "service two\n");
  useDebug.setState({ active: 2 });
  const view = render(<DebugServiceConsole sessionId={1} />);
  expect(screen.getByRole("log")).toHaveTextContent("service one");
  expect(screen.getByRole("log")).not.toHaveTextContent("service two");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(useDebug.getState().active).toBe(2);
  act(() => appendConsole(2, "stdout", "unrelated\n"));
  expect(screen.getByRole("log")).not.toHaveTextContent("unrelated");
  view.rerender(<DebugServiceConsole sessionId={2} />);
  expect(screen.getByRole("log")).toHaveTextContent("service two");
  expect(screen.getByRole("log")).not.toHaveTextContent("service one");
});

it("shares output and clearing with the interactive debugger console", () => {
  const session = adoptSession(1);
  appendConsole(1, "stdout", "shared log\n");
  render(
    <>
      <DebugServiceConsole sessionId={1} />
      <DebugConsole session={session} />
    </>,
  );
  expect(screen.getAllByRole("log").every((log) => log.textContent?.includes("shared log"))).toBe(true);
  expect(screen.getByRole("textbox", { name: "Debug console input" })).toBeEnabled();
  const clear = screen.getAllByRole("button", { name: "Clear Console" })[0]!;
  fireEvent.click(clear);
  for (const log of screen.getAllByRole("log")) expect(within(log).queryByText("shared log")).toBeNull();
  expect(useDebug.getState().console[1]).toEqual([]);
});

it("shows an empty state when its source has been cleared", () => {
  render(<DebugServiceConsole sessionId={99} />);
  expect(screen.getByText("No debug output available")).toBeTruthy();
  expect(screen.queryByRole("log")).toBeNull();
});

it("explains why a remote attached process may have no application logs", () => {
  adoptSession(1, {
    launch: {
      name: "remote",
      adapter: "java-debug",
      request: "attach",
      program: null,
      args: [],
      cwd: "/p",
      env: {},
      extraJson: null,
    },
  });
  render(<DebugServiceConsole sessionId={1} />);
  expect(screen.getByText("The attached process may not provide standard output to the debugger.")).toBeTruthy();
});
