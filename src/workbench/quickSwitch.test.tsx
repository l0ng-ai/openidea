import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuHost, hideContextMenu, MenuList } from "@/ui";
import { showQuickSwitch, THEME_PREVIEW_DELAY, themePreview } from "./quickSwitch";
import {
  applyThemeAttributes,
  currentThemeId,
  STARTUP_THEME_KEY,
  syncWindowBackground,
  useThemeOverride,
} from "./theme";

const root = document.documentElement;
const shown = () => [root.dataset.theme, root.dataset.colorTheme ?? null];

beforeEach(() => {
  vi.useFakeTimers();
  useThemeOverride.setState({ theme: null });
  applyThemeAttributes(currentThemeId());
});

afterEach(() => {
  act(() => hideContextMenu());
  vi.useRealTimers();
  useThemeOverride.setState({ theme: null });
  applyThemeAttributes(currentThemeId());
});

describe("menu items", () => {
  it("report becoming active by pointer or keyboard, not on opening", () => {
    const active: string[] = [];
    const item = (label: string) => ({ label, onActive: () => active.push(label), run: () => {} });
    render(<MenuList items={[item("One"), item("Two"), item("Three")]} onDone={() => {}} />);
    expect(active).toEqual([]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Three" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "o" });
    expect(active).toEqual(["Two", "Three", "One"]);
  });
});

describe("Quick Switch theme preview", () => {
  it("shows the active theme after a moment, in this window only, and takes it back", () => {
    syncWindowBackground();
    const startup = localStorage.getItem(STARTUP_THEME_KEY);
    const before = shown();
    const preview = themePreview();
    preview.preview("solarized-dark");
    vi.advanceTimersByTime(THEME_PREVIEW_DELAY - 1);
    expect(shown()).toEqual(before);
    // Moving on restarts the delay: only the theme the user stays on shows.
    preview.preview("one-light");
    vi.advanceTimersByTime(THEME_PREVIEW_DELAY - 1);
    expect(shown()).toEqual(before);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual(["light", "one-light"]);
    // Nothing is selected or saved, not even as the next start-up's theme.
    expect(useThemeOverride.getState().theme).toBeNull();
    expect(localStorage.getItem(STARTUP_THEME_KEY)).toBe(startup);

    preview.restore();
    expect(shown()).toEqual(before);
    expect(localStorage.getItem(STARTUP_THEME_KEY)).toBe(startup);
    preview.preview("solarized-dark");
    vi.advanceTimersByTime(THEME_PREVIEW_DELAY);
    preview.end();
    expect(shown()).toEqual(before);
  });

  it("selects the chosen theme and keeps it when the menu closes", () => {
    const preview = themePreview();
    preview.preview("solarized-dark");
    vi.advanceTimersByTime(THEME_PREVIEW_DELAY);
    preview.choose("one-dark");
    expect(useThemeOverride.getState().theme).toBe("one-dark");
    expect(shown()).toEqual(["dark", "one-dark"]);
    preview.end();
    expect(shown()).toEqual(["dark", "one-dark"]);
  });

  it("previews from the Theme submenu and takes the preview back when the menu closes", async () => {
    const before = shown();
    render(<ContextMenuHost />);
    act(() => showQuickSwitch({ x: 10, y: 10 }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Theme" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerEnter(screen.getByRole("menuitemcheckbox", { name: "Solarized Light" }));
    act(() => vi.advanceTimersByTime(THEME_PREVIEW_DELAY));
    expect(shown()).toEqual(["light", "solarized-light"]);

    // Back on another entry: the selected theme again.
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Keymap" }));
    expect(shown()).toEqual(before);

    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Theme" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerEnter(screen.getByRole("menuitemcheckbox", { name: "Solarized Light" }));
    act(() => vi.advanceTimersByTime(THEME_PREVIEW_DELAY));
    act(() => hideContextMenu());
    await act(async () => {});
    expect(shown()).toEqual(before);
    expect(useThemeOverride.getState().theme).toBeNull();
  });

  it("selects a theme clicked in the Theme submenu", async () => {
    render(<ContextMenuHost />);
    act(() => showQuickSwitch({ x: 10, y: 10 }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Theme" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Solarized Dark" }));
    await act(async () => {});
    expect(useThemeOverride.getState().theme).toBe("solarized-dark");
    expect(shown()).toEqual(["dark", "solarized-dark"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
