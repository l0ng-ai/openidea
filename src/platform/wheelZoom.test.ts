import { beforeEach, describe, expect, it } from "vitest";
import { resetWheelZoomGesture, wheelZoomStep } from "./wheelZoom";

let t = 0;
const wheel = (deltaY: number, mod = true, gap = 16) => {
  t += gap;
  return wheelZoomStep({ deltaY, metaKey: mod, ctrlKey: false, timeStamp: t });
};

describe("wheelZoomStep", () => {
  beforeEach(() => {
    resetWheelZoomGesture();
    t = 1000;
  });

  it("zooms in and out with ⌘ held from the start of the gesture", () => {
    expect(wheel(-4)).toBe(1);
    expect(wheel(-6)).toBe(1);
    expect(wheel(10, true, 500)).toBe(-1);
  });

  it("leaves plain scrolling alone", () => {
    expect(wheel(-10, false)).toBeNull();
  });

  it("keeps scrolling the inertia of a plain scroll when ⌘ is pressed during it", () => {
    expect(wheel(-40, false)).toBeNull();
    expect(wheel(-30)).toBeNull();
    expect(wheel(-20)).toBeNull();
    expect(wheel(-10, true, 500)).toBe(1);
  });

  it("stops zooming once the deltas decay like inertia, without scrolling", () => {
    for (const d of [-8, -12, -15]) expect(wheel(d)).toBe(1);
    expect(wheel(-14)).toBe(1);
    expect(wheel(-12)).toBe(1);
    expect(wheel(-9)).toBe(1);
    expect(wheel(-6)).toBe(0);
    expect(wheel(-4)).toBe(0);
    expect(wheel(-5)).toBe(0);
  });

  it("never swallows a plain wheel event, even during a zoom gesture", () => {
    expect(wheel(-10)).toBe(1);
    expect(wheel(-10, false)).toBeNull();
  });

  it("gives the same answer for repeated calls with one event", () => {
    const e = { deltaY: -10, metaKey: true, ctrlKey: false, timeStamp: 5000 };
    expect(wheelZoomStep(e)).toBe(1);
    expect(wheelZoomStep(e)).toBe(1);
  });
});
