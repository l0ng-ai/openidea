import { afterEach, describe, expect, it, vi } from "vitest";
import { reducedMotion } from "./motion";

describe("reducedMotion", () => {
  afterEach(() => {
    delete document.documentElement.dataset.reduceMotion;
    vi.unstubAllGlobals();
  });
  const media = (matches: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("reduce") }));

  it("follows the Reduce motion setting", () => {
    media(false);
    expect(reducedMotion()).toBe(false);
    document.documentElement.dataset.reduceMotion = "";
    expect(reducedMotion()).toBe(true);
  });

  it("follows the system preference when the setting is off", () => {
    media(true);
    expect(reducedMotion()).toBe(true);
  });
});
