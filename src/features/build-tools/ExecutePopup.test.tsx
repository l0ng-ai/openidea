import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GradleModel } from "@/platform/ipc";
import { ExecutePopupHost } from "./ExecutePopup";
import { goalCompletions } from "./model";
import { pushHistory, useBuild } from "./store";

beforeEach(() => {
  localStorage.clear();
  useBuild.setState({ root: "/p", model: null, executeOpen: "maven" });
});
afterEach(() => {
  cleanup();
  useBuild.setState({ executeOpen: null });
});

it("separates recent commands from Maven goals and accepts a recent command with Tab", () => {
  pushHistory("maven", "package -o");
  render(<ExecutePopupHost />);
  expect(screen.getByText("Recent")).toBeTruthy();
  expect(screen.getByText("Maven Goals")).toBeTruthy();
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("package -o");
});

it("skips section headers during keyboard navigation", () => {
  pushHistory("maven", "package -o");
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("clean ");
});

it("omits the empty Recent section when no commands have been run", () => {
  render(<ExecutePopupHost />);
  expect(screen.queryByText("Recent")).toBeNull();
  expect(screen.getByText("Maven Goals")).toBeTruthy();
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("clean ");
});

it("starts PageUp on a completion rather than a section", () => {
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "PageUp" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("clean ");
});

it.each([
  [["ArrowUp"], "site-deploy "],
  [["ArrowUp", "ArrowDown"], "package -o"],
  [["ArrowDown", "ArrowUp"], "site-deploy "],
  [["ArrowDown", "ArrowDown", "ArrowUp"], "package -o"],
  [["PageDown", "PageUp"], "package -o"],
] as const)("navigates sections and wraps with %j", (keys, expected) => {
  pushHistory("maven", "package -o");
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  for (const key of keys) fireEvent.keyDown(input, { key });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue(expected);
});

it("clears selection when typing changes the rows, and ignores section clicks", () => {
  pushHistory("maven", "package -o");
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.change(input, { target: { value: "cl" } });
  fireEvent.click(screen.getByText("Maven Goals"));
  expect(input).toHaveValue("cl");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("clean ");
});

it("keeps an empty completion list safe for all navigation and acceptance keys", () => {
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "-Dunknown" } });
  for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Tab", "Enter"]) {
    fireEvent.keyDown(input, { key });
    expect(input).toHaveValue("-Dunknown");
  }
  expect(screen.queryByText("Maven Goals")).toBeNull();
});

it("PageDown selects a completion rather than a section at its landing position", () => {
  const history = Array.from({ length: 9 }, (_, i) => `command-${i}`);
  for (const line of history) pushHistory("maven", line);
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "PageDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue(`${goalCompletions("", [])[0]!.line} `);
});

it("resets selection when changing the Gradle build used for completion", () => {
  const build = (dir: string, name: string): GradleModel => ({
    dir,
    projects: [
      { path: ":", name, dir, buildFile: "build.gradle.kts", tasks: [{ name, group: "build", description: null }] },
    ],
    javaVersion: null,
    command: "gradle",
    env: {},
    syncedAt: null,
    stale: false,
    syncError: null,
  });
  useBuild.setState({
    executeOpen: "gradle",
    model: { maven: null, gradle: [build("a", "assemble"), build("b", "build")] },
  });
  render(<ExecutePopupHost />);
  const input = screen.getByRole("textbox");
  expect(screen.getByText("Gradle Tasks")).toBeTruthy();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("button", { name: "Project to run in" }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Project to run in" })).getByText("build"));
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("build ");
  act(() => useBuild.setState({ model: { maven: null, gradle: [] } }));
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("build ");
});
