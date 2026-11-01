import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { ToolWindowStripe } from "./ToolWindows";
import { resetToolWindowLayout, useToolWindowLayout } from "./store";

beforeEach(() => {
  resetToolWindowLayout();
  useProject.setState({ settings: null });
});

afterEach(() => useProject.setState({ settings: null }));

it("hides stripe counts immediately and restores the current count when enabled", () => {
  const useCount = create(() => ({ count: 3 }));
  render(
    <ToolWindowStripe
      side="left"
      visible={useToolWindowLayout.getState().visible}
      windows={[
        {
          id: "git",
          title: "Git",
          icon: "folder",
          anchor: "left",
          component: () => null,
          useBadge: () => useCount((s) => s.count),
        },
      ]}
    />,
  );
  const button = screen.getByRole("button", { name: "Git" });
  expect(button).toHaveTextContent("3");
  act(() => useProject.setState({ settings: { appearance: { showToolWindowBadges: false } } }));
  expect(button).not.toHaveTextContent("3");
  act(() => useCount.setState({ count: 7 }));
  expect(button).not.toHaveTextContent("7");
  act(() => useProject.setState({ settings: { appearance: { showToolWindowBadges: true } } }));
  expect(button).toHaveTextContent("7");
  act(() => useCount.setState({ count: 0 }));
  expect(button).not.toHaveTextContent("0");
});
