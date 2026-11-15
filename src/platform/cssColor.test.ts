import { afterEach, describe, expect, it, vi } from "vitest";
import { computedTokenColor, parseColor, resolveTokenColor, toHex, toRgb } from "./cssColor";

afterEach(() => vi.restoreAllMocks());

describe("css colours", () => {
  it("parses hex, rgb() and color(srgb) and formats them back", () => {
    expect(parseColor("#eee8d5")).toEqual([238, 232, 213, 1]);
    expect(parseColor("#fff8")).toEqual([255, 255, 255, 0x88 / 255]);
    expect(parseColor("rgb(33, 37, 43)")).toEqual([33, 37, 43, 1]);
    expect(parseColor("rgba(0 0 0 / 50%)")).toEqual([0, 0, 0, 0.5]);
    expect(parseColor("color(srgb 0.5 0.25 0.75 / 0.8)")).toEqual([127.5, 63.75, 191.25, 0.8]);
    expect(parseColor("hsl(220, 13%, 15%)")).toBeNull();
    expect(toHex([33, 37, 43, 1])).toBe("#21252b");
    expect(toHex([127.5, 63.75, 191.25, 0.8])).toBe("#8040bfcc");
    expect(toRgb([33, 37, 43, 1])).toBe("rgb(33, 37, 43)");
    expect(toRgb([0, 0, 0, 0.5])).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("resolves tokens written as hsl(), color-mix() or var() through the browser", () => {
    const root = document.documentElement;
    const tokens: Record<string, string> = { "--hex": "#073642", "--hsl": "hsl(220, 13%, 15%)", "--none": "" };
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      (el) =>
        (el === root
          ? { getPropertyValue: (n: string) => tokens[n] ?? "" }
          : {
              color: (el as HTMLElement).style.color === "var(--hsl)" ? "rgb(33, 37, 43)" : "",
            }) as unknown as CSSStyleDeclaration,
    );
    expect(resolveTokenColor("--hex", root)).toEqual([7, 54, 66, 1]);
    expect(resolveTokenColor("--hsl", root)).toEqual([33, 37, 43, 1]);
    expect(resolveTokenColor("--none", root)).toBeNull();
  });

  it("resolves every token through one probe element, adding none per token", () => {
    const root = document.documentElement;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      (el) =>
        (el === root
          ? { getPropertyValue: () => "hsl(220, 13%, 15%)" }
          : { color: "rgb(33, 37, 43)" }) as unknown as CSSStyleDeclaration,
    );
    root.querySelector("[data-token-probe]")?.remove();
    const added = vi.spyOn(root, "appendChild");
    for (const name of ["--a", "--b", "--c"]) expect(resolveTokenColor(name, root)).toEqual([33, 37, 43, 1]);
    expect(added).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll("[data-token-probe]")).toHaveLength(1);
    // Replaced when something removed it.
    root.querySelector("[data-token-probe]")!.remove();
    expect(computedTokenColor("--a", root)).toBe("rgb(33, 37, 43)");
    expect(root.querySelectorAll("[data-token-probe]")).toHaveLength(1);
  });
});
