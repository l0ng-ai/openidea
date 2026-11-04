import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tooltipBounds } from "./setup";

const el = (r: Partial<DOMRect>) => ({ getBoundingClientRect: () => r as DOMRect }) as Element;
const original = window.innerWidth;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
});
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
});

describe("tooltipBounds", () => {
  it.each([
    ["editor flush with the right edge", { left: 300, right: 1200 }, 300, 1200],
    ["narrow split pane", { left: 0, right: 400 }, 0, 400],
    ["editor in the middle", { left: 250, right: 750 }, 250, 750],
    ["editor spilling outside the window", { left: -20, right: 1500 }, 0, 1200],
  ])("%s", (_, rect, left, right) => {
    const b = tooltipBounds({ scrollDOM: el({ top: 80 }), dom: el(rect) });
    expect(b).toMatchObject({ top: 80, left, right });
  });
});
