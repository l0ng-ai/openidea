import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { Tabs } from "@/ui";
import { registerToolWindow } from "../contributions";
import { installToolWindowActions } from "./actions";
import {
  isToolWindowVisible,
  resetToolWindowLayout,
  setFocusedToolWindow,
  showToolWindow,
  useToolWindowLayout,
} from "./store";
import { ToolWindowLayout } from "./ToolWindows";

const Empty = () => null;
const closeContentTab = vi.fn();
const pinContentTab = vi.fn();
let disposers: Array<() => void> = [];

beforeEach(() => {
  resetToolWindowLayout();
  closeContentTab.mockClear();
  pinContentTab.mockClear();
  disposers = [
    registerToolWindow({
      id: "run",
      title: "Run",
      icon: "terminal",
      anchor: "bottom",
      requiresProject: false,
      component: Empty,
    }),
    registerToolWindow({
      id: "problems",
      title: "Problems",
      icon: "file",
      anchor: "bottom",
      requiresProject: false,
      component: Empty,
      headerContent: () => (
        <div role="tablist" aria-label="Views">
          <Tabs
            items={[{ id: "file", label: "File" }]}
            activeId="file"
            onSelect={() => {}}
            onClose={closeContentTab}
            onTogglePin={pinContentTab}
          />
        </div>
      ),
    }),
  ];
  disposers.push(installToolWindowActions());
});

afterEach(() => disposers.forEach((d) => d()));

const header = (id: string) => document.querySelector<HTMLElement>(`[data-toolwindow="${id}"] header`)!;

it("middle click on the header hides the tool window", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={null} />);
  expect(isToolWindowVisible("run")).toBe(true);
  fireEvent.mouseDown(header("run"), { button: 1 });
  expect(isToolWindowVisible("run")).toBe(false);
});

it("middle click on the header title hides the tool window", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={null} />);
  fireEvent.mouseDown(screen.getByText("Run"), { button: 1 });
  expect(isToolWindowVisible("run")).toBe(false);
});

it("middle click on a header button leaves the tool window open", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={null} />);
  fireEvent.mouseDown(screen.getByRole("button", { name: "Hide" }), { button: 1 });
  expect(isToolWindowVisible("run")).toBe(true);
});

it("middle click on a header content tab closes the tab, not the window", () => {
  showToolWindow("problems");
  render(<ToolWindowLayout editor={null} />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "File" }), { button: 1 });
  expect(closeContentTab).toHaveBeenCalledWith("file");
  expect(isToolWindowVisible("problems")).toBe(true);
});

it("Pin / Unpin Tool Window Tab pins the selected content tab of the focused window", async () => {
  showToolWindow("problems");
  render(<ToolWindowLayout editor={null} />);
  // Without the focus in the tool window the action does not run.
  await executeAction("toolwindow.pinContent");
  expect(pinContentTab).not.toHaveBeenCalled();
  setFocusedToolWindow("problems");
  await executeAction("toolwindow.pinContent");
  expect(pinContentTab).toHaveBeenCalledWith("file");
  setFocusedToolWindow(null);
});

it("header double click hides the editor and restores its previous size", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={<input aria-label="Editor" />} />);
  const editor = screen.getByRole("textbox", { name: "Editor" });
  const sizes = useToolWindowLayout.getState().sizes;
  editor.focus();
  fireEvent.doubleClick(header("run"));
  expect(editor).not.toBeVisible();
  expect(editor).not.toHaveFocus();
  expect(useToolWindowLayout.getState().focusRequest?.id).toBe("run");
  fireEvent.doubleClick(header("run"));
  expect(editor).toBeVisible();
  expect(useToolWindowLayout.getState().sizes).toEqual(sizes);
});
