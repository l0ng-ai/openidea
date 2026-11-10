import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TOOLTIP_DELAY, TooltipHost, tooltipAttrs } from "./Tooltip";
import styles from "./Tooltip.module.css";

describe("tooltipAttrs", () => {
  it("returns empty object when text is missing", () => {
    expect(tooltipAttrs(undefined)).toEqual({});
    expect(tooltipAttrs("")).toEqual({});
  });

  it("sets data-tooltip and optional shortcut", () => {
    expect(tooltipAttrs("Close Tab")).toEqual({ "data-tooltip": "Close Tab" });
    expect(tooltipAttrs("Save All", "Ctrl+S")).toEqual({
      "data-tooltip": "Save All",
      "data-tooltip-shortcut": "Ctrl+S",
    });
  });
});

describe("TooltipHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows tooltip text with styles.text class and shortcut after delay", async () => {
    render(
      <div>
        <TooltipHost />
        <button type="button" {...tooltipAttrs("d:/project/src/main.rs", "Ctrl+Shift+S")}>
          Tab
        </button>
      </div>,
    );

    const button = screen.getByRole("button", { name: "Tab" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerOver(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveClass(styles.tooltip!);

    const textSpan = tooltip.querySelector(`.${styles.text!}`);
    expect(textSpan).toBeInTheDocument();
    expect(textSpan?.textContent).toBe("d:/project/src/main.rs");

    const shortcutSpan = tooltip.querySelector(`.${styles.shortcut!}`);
    expect(shortcutSpan).toBeInTheDocument();
    expect(shortcutSpan?.textContent).toBe("Ctrl+Shift+S");

    // Pointer out hides the tooltip
    fireEvent.pointerOut(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each(["left", "right", undefined, "invalid"])("keeps dismissal behavior for %s tooltips", (stripe) => {
    render(
      <>
        <TooltipHost />
        <button type="button" data-tooltip-stripe={stripe} {...tooltipAttrs("Project", "⌘1", true)}>
          Project
        </button>
      </>,
    );
    const button = screen.getByRole("button");
    for (const dismiss of [
      () => fireEvent.pointerOut(button),
      () => fireEvent.pointerDown(button),
      () => fireEvent.keyDown(button, { key: "Escape" }),
      () => fireEvent.scroll(document),
      () => fireEvent.wheel(document),
      () => fireEvent.blur(window),
    ]) {
      fireEvent.pointerOver(button);
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY));
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.classList.contains(styles.stripe!)).toBe(stripe === "left" || stripe === "right");
      dismiss();
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });
});
