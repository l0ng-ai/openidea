import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { useWindowGroup } from "@/platform/windowGroups";
import { useContextMenuStore } from "@/ui/Menu";
import { WindowGroupTabs } from "./WindowGroupTabs";

vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.mocked(executeAction).mockClear();
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
    ],
  });
});

it("switches and closes the intended project with mouse and keyboard", () => {
  render(<WindowGroupTabs />);
  const first = screen.getByRole("tab", { name: "Frontend" });
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Backend" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "project-1");
  fireEvent.click(screen.getByRole("button", { name: "Close Backend" }));
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTab", "project-1");
  fireEvent.click(first);
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "main");
});

it("removes the tab row when the group dissolves", () => {
  useWindowGroup.setState({ tabs: [] });
  render(<WindowGroupTabs />);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

it("offers closing the other tabs and those on either side of the clicked tab", () => {
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
      { label: "project-2", name: "Docs", root: "/docs", current: false },
    ],
  });
  render(<WindowGroupTabs />);
  const menuFor = (name: string) => {
    fireEvent.contextMenu(screen.getByRole("tab", { name }));
    const items = useContextMenuStore.getState().menu!.items;
    return (label: string) =>
      items.find((i) => "label" in i && i.label === label) as { disabled?: boolean; run?: () => unknown };
  };
  const first = menuFor("Frontend");
  expect(first("Close Tabs to the Left").disabled).toBe(true);
  expect(first("Close Tabs to the Right").disabled).toBe(false);
  const middle = menuFor("Backend");
  void middle("Close Other Tabs").run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.closeOtherTabs", "project-1");
  void middle("Close Tabs to the Left").run?.();
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTabsToLeft", "project-1");
  expect(menuFor("Docs")("Close Tabs to the Right").disabled).toBe(true);
});
