import { beforeEach, describe, expect, it, vi } from "vitest";
const { native, discover, detect } = vi.hoisted(() => ({
  native: vi.fn(() => true),
  discover: vi.fn(),
  detect: vi.fn(),
}));
vi.mock("./candidateFonts", () => ({ detectCandidateFonts: detect }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native }));
vi.mock("@/bindings", () => ({ commands: { systemFontFamilies: discover } }));
import { bundledFonts, loadSystemFonts, useSystemFontStore } from "./systemFonts";

beforeEach(() => {
  native.mockReturnValue(true);
  discover.mockReset();
  detect.mockReset().mockReturnValue([{ name: "Menlo", monospaced: true }]);
  useSystemFontStore.setState({ fonts: bundledFonts, status: "idle", source: "bundled" });
});
describe("local font discovery", () => {
  it("shares an in-flight request, caches families outside the old list and explicitly refreshes", async () => {
    let resolve!: (fonts: unknown) => void;
    discover.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = loadSystemFonts();
    expect(useSystemFontStore.getState().status).toBe("loading");
    expect(loadSystemFonts()).toBe(first);
    await Promise.resolve();
    resolve({
      status: "ok",
      data: [
        { name: "Maple Mono NF", monospaced: true },
        { name: "maple mono nf", monospaced: true },
      ],
    });
    await first;
    expect(useSystemFontStore.getState().fonts.map((f) => f.name)).toEqual([
      "Inter",
      "JetBrains Mono",
      "maple mono nf",
    ]);
    await loadSystemFonts();
    expect(discover).toHaveBeenCalledTimes(1);
    discover.mockResolvedValue({ status: "ok", data: [] });
    await loadSystemFonts(true);
    expect(discover).toHaveBeenLastCalledWith(true);
    expect(useSystemFontStore.getState()).toMatchObject({ status: "empty", source: "native" });
    expect(detect).not.toHaveBeenCalled();
    expect(useSystemFontStore.getState().fonts).toEqual([bundledFonts[1], bundledFonts[0]]);
  });
  it("reports errors without losing suggestions, then retries", async () => {
    discover.mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "Unavailable" } });
    await loadSystemFonts();
    expect(useSystemFontStore.getState()).toMatchObject({ status: "error", source: "limited" });
    expect(useSystemFontStore.getState().fonts.some((f) => f.name === "Menlo")).toBe(true);
    discover.mockResolvedValue({ status: "ok", data: [{ name: "思源宋体", monospaced: false }] });
    await loadSystemFonts(true);
    expect(useSystemFontStore.getState()).toMatchObject({ status: "ready", source: "native" });
    expect(useSystemFontStore.getState().fonts.some((f) => f.name === "Menlo")).toBe(false);
    expect(useSystemFontStore.getState().fonts.some((f) => f.name === "思源宋体")).toBe(true);
  });
  it("does not invoke desktop APIs in browser development", async () => {
    native.mockReturnValue(false);
    await loadSystemFonts();
    expect(discover).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledOnce();
    expect(useSystemFontStore.getState().status).toBe("browser");
  });
});

it.each([{ fonts: [] }, { fonts: [{ name: "Outside Legacy List", monospaced: true }] }])(
  "retains successful native catalogs, including empty ones, after refresh failure: %j",
  async ({ fonts }) => {
    discover.mockResolvedValueOnce({ status: "ok", data: fonts });
    await loadSystemFonts();
    const previous = useSystemFontStore.getState().fonts;
    discover.mockRejectedValueOnce(new Error("native unavailable"));
    await loadSystemFonts(true);
    expect(useSystemFontStore.getState()).toMatchObject({ status: "error", source: "native", fonts: previous });
    expect(detect).not.toHaveBeenCalled();
  },
);
it("keeps bundled/manual recovery usable when candidate probing also fails", async () => {
  discover.mockRejectedValue(new Error("native unavailable"));
  detect.mockImplementation(() => {
    throw new Error("canvas unavailable");
  });
  await loadSystemFonts();
  expect(useSystemFontStore.getState()).toMatchObject({ status: "error", source: "limited" });
  expect(useSystemFontStore.getState().fonts.map((font) => font.name)).toEqual(["Inter", "JetBrains Mono"]);
});
