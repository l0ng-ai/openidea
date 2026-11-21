import { describe, expect, it } from "vitest";
import { isNavigating, navigationStarted, onNavigation } from "./foreground";

describe("navigation before background requests", () => {
  it("reports the first navigation starting and the last one finishing", () => {
    const seen: boolean[] = [];
    const off = onNavigation((n) => seen.push(n));
    const a = navigationStarted();
    const b = navigationStarted();
    expect(isNavigating()).toBe(true);
    a();
    a();
    expect(isNavigating()).toBe(true);
    b();
    expect(isNavigating()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
  });
});
