import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tabs } from "@/ui";
import { registerToolWindow } from "../contributions";
import { installToolWindowActions } from "./actions";
import { isToolWindowVisible, resetToolWindowLayout, showToolWindow, useToolWindowLayout, viewModeOf } from "./store";
import { ToolWindowLayout } from "./ToolWindows";

const Empty = () => null;
const closeContentTab = vi.fn();
let disposers: Array<() => void> = [];

beforeEach(() => {
  resetToolWindowLayout();
  closeContentTab.mockClear();
  disposers = [
    installToolWindowActions(),
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
          <Tabs items={[{ id: "file", label: "File" }]} activeId="file" onSelect={() => {}} onClose={closeContentTab} />
        </div>
      ),
    }),
  ];
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

it("View Mode › Undock lays the window over the editor and frees its track", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={null} />);
  const area = document.querySelector<HTMLElement>('[data-slot="bottom"]')!;
  const grid = area.closest<HTMLElement>('[data-anchor="bottom"]')!.parentElement!;
  expect(grid.style.getPropertyValue("--tw-bottom")).not.toBe("0px");

  fireEvent.click(screen.getByRole("button", { name: "Options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "View Mode" }));
  expect(screen.getByRole("menuitemcheckbox", { name: "Dock Pinned" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Undock" }));

  expect(viewModeOf("run")).toBe("undock");
  expect(isToolWindowVisible("run")).toBe(true);
  expect(grid.style.getPropertyValue("--tw-bottom")).toBe("0px");
  expect(area.style.getPropertyValue("--undock-size")).toBe(`${useToolWindowLayout.getState().sizes.bottom}px`);
  expect(screen.getByRole("separator", { name: "Resize undocked bottom tool window" })).toBeInTheDocument();
});

it("a menu opened from the header returns focus to the window, not the editor", () => {
  showToolWindow("run");
  render(<ToolWindowLayout editor={<input aria-label="Editor" />} />);
  screen.getByRole("textbox", { name: "Editor" }).focus();
  const options = screen.getByRole("button", { name: "Options" });
  // Like WebKit, jsdom doesn't focus a clicked button.
  fireEvent.click(options);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(options);
});
