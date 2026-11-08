import { afterEach, expect, it, vi } from "vitest";
import { gutterIconMarkup } from "@/ui/icons";
import { projectMarkerIcon, resolveMarkerIcon } from "./markerIcons";
import { markerIcon } from "./lineMarkerGutter";

const mocks = vi.hoisted(() => ({ assets: vi.fn() }));
vi.mock("./backend", () => ({ pluginsBackend: () => ({ assets: mocks.assets }) }));
afterEach(() => vi.clearAllMocks());
const svg = (shape: string) => `<svg viewBox="0 0 16 16">${shape}</svg>`;

it("resolves declared package paths within their plugin and uses the dark SVG", async () => {
  mocks.assets.mockResolvedValue([
    ["markerIcon/resource/light", svg('<rect width="16" height="16"/>')],
    ["markerIcon/resource/dark", svg('<circle cx="8" cy="8" r="7"/>')],
  ]);
  const remove = projectMarkerIcon("p", { id: "resource", icon: "icons/resource.svg" });
  try {
    const name = (await resolveMarkerIcon("p", "icons/resource.svg"))!;
    expect(mocks.assets).toHaveBeenCalledWith("p", "markerIcon/resource/");
    expect(markerIcon(name)).toBe(name);
    expect(gutterIconMarkup(name)).toContain("<circle");
    expect(await resolveMarkerIcon("other", "icons/resource.svg")).toBe("icons/resource.svg");
  } finally {
    remove();
  }
  expect(await resolveMarkerIcon("p", "icons/resource.svg")).toBe("icons/resource.svg");
});

it("retains built-in names, legacy aliases and unknown-icon fallback", async () => {
  expect(markerIcon(await resolveMarkerIcon("p", "database"))).toBe("database");
  expect(markerIcon("overriding")).toBe("gutter-overriding");
  expect(markerIcon("not-an-icon")).toBe("gutter-implementing");
  expect(markerIcon("__proto__")).toBe("gutter-implementing");
  expect(markerIcon("constructor")).toBe("gutter-implementing");
  expect(markerIcon(null)).toBe("gutter-implementing");
  expect(mocks.assets).not.toHaveBeenCalled();
});

it("keeps a replacement when an older declaration is disposed", async () => {
  mocks.assets.mockResolvedValue([["markerIcon/resource/light", svg('<rect width="16" height="16"/>')]]);
  const removeOld = projectMarkerIcon("p", { id: "resource", icon: "icons/resource.svg" });
  const removeNew = projectMarkerIcon("p", { id: "resource", icon: "icons/resource.svg" });
  removeOld();
  expect(await resolveMarkerIcon("p", "icons/resource.svg")).toMatch(/^ext:/);
  removeNew();
});

it("falls back when an asset fails to load", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.assets.mockRejectedValue(new Error("disabled"));
  const remove = projectMarkerIcon("p", { id: "resource", icon: "icons/resource.svg" });
  try {
    expect(markerIcon(await resolveMarkerIcon("p", "icons/resource.svg"))).toBe("gutter-implementing");
  } finally {
    remove();
    warning.mockRestore();
  }
});
