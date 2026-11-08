import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExecutePopupHost } from "./ExecutePopup";
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
