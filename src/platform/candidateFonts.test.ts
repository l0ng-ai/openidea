import { afterEach, expect, it, vi } from "vitest";
import { detectCandidateFonts } from "./candidateFonts";

afterEach(() => vi.restoreAllMocks());
it("probes the legacy list and classifies measured mono and proportional families", () => {
  const ctx = {
    font: "",
    measureText(text: string) {
      if (this.font.includes('"Menlo"')) return { width: 120 };
      if (this.font.includes('"Georgia"')) return { width: text.startsWith("i") ? 60 : 180 };
      return { width: 100 };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  expect(detectCandidateFonts()).toEqual([
    { name: "Menlo", monospaced: true },
    { name: "Georgia", monospaced: false },
  ]);
});
it("returns no inferred families when Canvas is absent", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  expect(detectCandidateFonts()).toEqual([]);
});
it("contains failures from Canvas and never claims candidates are installed", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    throw new Error("disabled");
  });
  expect(detectCandidateFonts()).toEqual([]);
});
it("does not treat invalid measurements as available fonts", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: () => ({ width: Number.NaN }),
  } as unknown as CanvasRenderingContext2D);
  expect(detectCandidateFonts()).toEqual([]);
});
