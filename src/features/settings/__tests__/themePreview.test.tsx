import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { applyThemeAttributes, currentThemeId, useThemeOverride } from "@/workbench/theme";
import { THEME_PREVIEW_DELAY } from "@/workbench/quickSwitch";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, resetPage } from "../model/staging";
import { PageContext } from "../components/context";
import { BEHAVIOR_PAGES } from "../pages/behavior";

const root = document.documentElement;
const shown = () => [root.dataset.theme, root.dataset.colorTheme ?? null];

function renderThemeRow() {
  const page = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!;
  const option = page.sections!.flatMap((s) => s.options).find((o) => o.kind === "custom" && o.label === "Theme");
  if (option?.kind !== "custom") throw new Error("no Theme row");
  const Row = option.component;
  return render(
    <PageContext.Provider value={{ pageId: page.id, scope: "global" }}>
      <Row />
    </PageContext.Provider>,
  );
}

const pick = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Theme" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(label));
};

beforeEach(() => {
  vi.useFakeTimers();
  useThemeOverride.setState({ theme: null });
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  applyThemeAttributes(currentThemeId());
  openSettings("appearance");
});

afterEach(() => {
  vi.useRealTimers();
  useThemeOverride.setState({ theme: null });
  applyThemeAttributes(currentThemeId());
});

describe("Settings › Appearance › Theme preview", () => {
  it("shows a picked theme in this window until Apply", () => {
    renderThemeRow();
    pick("Solarized Dark");
    expect(shown()).toEqual(["dark", "solarized-dark"]);
  });

  it("goes back to the selected theme when it is picked again before the hover preview shows", () => {
    renderThemeRow();
    expect(shown()).toEqual(["light", null]);
    pick("Solarized Dark");
    expect(shown()).toEqual(["dark", "solarized-dark"]);
    // Clicked quicker than the hover delay: the list itself never previewed anything.
    act(() => vi.advanceTimersByTime(THEME_PREVIEW_DELAY / 2));
    pick("Islands Light");
    act(() => vi.advanceTimersByTime(THEME_PREVIEW_DELAY));
    expect(screen.getByRole("button", { name: "Theme" })).toHaveTextContent("Islands Light");
    expect(shown()).toEqual(["light", null]);
  });

  it("goes back to the selected theme after hovering it long enough", () => {
    renderThemeRow();
    pick("Solarized Dark");
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    fireEvent.pointerEnter(within(screen.getByRole("listbox")).getByText("Islands Light"));
    act(() => vi.advanceTimersByTime(THEME_PREVIEW_DELAY));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Islands Light"));
    expect(shown()).toEqual(["light", null]);
  });

  it("goes back to the selected theme when the page is reset", () => {
    renderThemeRow();
    pick("Solarized Dark");
    act(() => resetPage("appearance"));
    expect(screen.getByRole("button", { name: "Theme" })).toHaveTextContent("Islands Light");
    expect(shown()).toEqual(["light", null]);
  });
});
