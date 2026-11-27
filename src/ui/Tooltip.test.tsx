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

describe("TooltipHost on cut-off text", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** jsdom lays nothing out: give `el` the widths a browser would. */
  const widths = (el: HTMLElement, scroll: number, client: number) => {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: client });
  };

  const hover = (el: Element) => {
    fireEvent.pointerOver(el);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY);
    });
    return screen.queryByRole("tooltip")?.textContent ?? null;
  };

  it("shows the whole text only while it is cut off", () => {
    render(
      <>
        <TooltipHost />
        <div style={{ textOverflow: "ellipsis", overflow: "hidden" }} data-testid="row">
          <span>origin/feature/REQ-126-明细汇总多选</span>
        </div>
      </>,
    );
    const row = screen.getByTestId("row");
    widths(row, 300, 120);
    expect(hover(row.firstElementChild!)).toBe("origin/feature/REQ-126-明细汇总多选");
    fireEvent.pointerOut(row);

    widths(row, 120, 120);
    expect(hover(row.firstElementChild!)).toBeNull();
  });

  it("leaves text with a title alone, and text without an ellipsis; adds its own tooltip beside it", () => {
    render(
      <>
        <TooltipHost />
        <div style={{ textOverflow: "ellipsis" }} title="native" data-testid="titled">
          long name
        </div>
        <div style={{ textOverflow: "ellipsis" }} data-no-tooltip="" data-testid="opted-out">
          long name
        </div>
        <div style={{ textOverflow: "clip" }} data-testid="clipped">
          long name
        </div>
        <div style={{ textOverflow: "ellipsis" }} data-testid="own" {...tooltipAttrs("Own tooltip", undefined, true)}>
          long name
        </div>
      </>,
    );
    for (const id of ["titled", "opted-out", "clipped", "own"]) widths(screen.getByTestId(id), 300, 120);
    expect(hover(screen.getByTestId("titled"))).toBeNull();
    expect(hover(screen.getByTestId("opted-out"))).toBeNull();
    expect(hover(screen.getByTestId("clipped"))).toBeNull();
    expect(hover(screen.getByTestId("own"))).toBe("long nameOwn tooltip");
  });
});

it("shows a tab's cut-off title whole, with the tab's own tooltip beside it", () => {
  vi.useFakeTimers();
  render(
    <>
      <TooltipHost />
      <div role="tab" {...tooltipAttrs("/repo/src/history/PscPrinted.js", undefined, true)}>
        <span style={{ textOverflow: "ellipsis" }} data-testid="label">
          历史记录: PscPrinted.js
        </span>
      </div>
    </>,
  );
  const label = screen.getByTestId("label");
  Object.defineProperty(label, "scrollWidth", { configurable: true, value: 300 });
  Object.defineProperty(label, "clientWidth", { configurable: true, value: 100 });
  fireEvent.pointerOver(label);
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY);
  });
  expect(screen.getByRole("tooltip").textContent).toBe("历史记录: PscPrinted.js/repo/src/history/PscPrinted.js");
  cleanup();
  vi.useRealTimers();
});
