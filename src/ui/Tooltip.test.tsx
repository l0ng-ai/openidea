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

it("flips above an anchor when the default bottom tooltip would overlap a native surface", async () => {
  vi.useFakeTimers();
  render(
    <>
      <TooltipHost />
      <button type="button" {...tooltipAttrs("Close", undefined, true)}>
        Close
      </button>
      <div data-native-surface="" data-testid="surface" />
    </>,
  );
  const button = screen.getByRole("button", { name: "Close" });
  const surface = screen.getByTestId("surface");
  const rect = (x: number, y: number, w: number, h: number): DOMRect =>
    ({
      x,
      y,
      left: x,
      top: y,
      right: x + w,
      bottom: y + h,
      width: w,
      height: h,
      toJSON: () => ({}),
    }) as DOMRect;
  const origClientW = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth");
  const origClientH = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === button) return rect(300, 60, 24, 24);
    if (this === surface) return rect(100, 90, 300, 400);
    if (this.getAttribute("role") === "tooltip") return rect(0, 0, 60, 24);
    return rect(0, 0, 0, 0);
  });

  fireEvent.pointerOver(button);
  await act(async () => {
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const tip = screen.getByRole("tooltip");

  // Placed above the button (y = 60 - 6 - 24 = 30), clear of the native surface starting at y = 90.
  expect(Number.parseFloat(tip.style.top)).toBeLessThanOrEqual(60 - 24);
  spy.mockRestore();
  if (origClientW) Object.defineProperty(document.documentElement, "clientWidth", origClientW);
  else Reflect.deleteProperty(document.documentElement, "clientWidth");
  if (origClientH) Object.defineProperty(document.documentElement, "clientHeight", origClientH);
  else Reflect.deleteProperty(document.documentElement, "clientHeight");
  cleanup();
  vi.useRealTimers();
});
