import { afterEach, describe, expect, it, vi } from "vitest";
import { monoFontFamily, quoteFontFamily, uiFontFamily } from "./fonts";

const BASE = "var(--font-mono)";

describe("monoFontFamily", () => {
  it.each([
    // #26: the default family names the bundled face, so it renders without a system install.
    ["JetBrains Mono", "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["", "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    [undefined, "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["JetBrains Mono", "PingFang SC", `"JetBrains Mono Variable", "JetBrains Mono", "PingFang SC", ${BASE}`],
    ["Inter", "", `"Inter Variable", "Inter", ${BASE}`],
    ["Fira Code", "Inter", `"Fira Code", "Inter Variable", "Inter", ${BASE}`],
    ["Inter", "JetBrains Mono", `"Inter Variable", "Inter", "JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["inter", "jetbrains mono", `"Inter Variable", "Inter", "JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["Fira Code", "", `"Fira Code", ${BASE}`],
    ['"Cascadia Code"', " Microsoft YaHei ", `"Cascadia Code", "Microsoft YaHei", ${BASE}`],
  ])("%j + fallback %j", (family, fallback, expected) => {
    expect(monoFontFamily(family, fallback, BASE)).toBe(expected);
  });

  it("always ends with the bundled stack, so a missing family never reaches the system default", () => {
    expect(monoFontFamily("Not Installed", "", '"JetBrains Mono Variable", monospace')).toBe(
      '"Not Installed", "JetBrains Mono Variable", monospace',
    );
  });
});

it("escapes CSS special characters without turning a family into a list", () => {
  expect(quoteFontFamily('A"B\\C,D')).toBe('"A\\22 B\\5c C,D"');
  expect(quoteFontFamily("A\nB")).toBe('"A\\a B"');
  expect(uiFontFamily("JetBrains Mono")).toContain('"JetBrains Mono Variable"');
  expect(uiFontFamily("Inter")).toContain('"Inter Variable"');
});

describe("uiFontFamily", () => {
  it.each([
    ["Inter", '"Inter Variable", "Inter", system-ui, sans-serif'],
    ["JetBrains Mono", '"JetBrains Mono Variable", "JetBrains Mono", system-ui, sans-serif'],
    [' "PingFang SC" ', '"PingFang SC", system-ui, sans-serif'],
  ])("%j", (family, expected) => {
    expect(uiFontFamily(family)).toBe(expected);
  });
});

describe("macOS user font resolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function resolver(available: boolean | "symbols", os = "macos") {
    vi.resetModules();
    const invoke = vi.fn();
    vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
    vi.doMock("./platformInfo", () => ({ guessOs: () => os }));
    const ctx = {
      font: "",
      measureText(text: string) {
        const covered = available === true || (available === "symbols" && text.includes("\uF418"));
        return { width: covered && this.font.includes('"') ? 200 : 100 };
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const registered: { family: string; descriptors: unknown }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(
          public family: string,
          _bytes: ArrayBuffer,
          public descriptors: unknown,
        ) {
          registered.push(this);
        }
        load() {
          return Promise.resolve(this);
        }
      },
    );
    const load = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn(), load } });
    const header = new TextEncoder().encode(
      JSON.stringify([
        { weight: 400, style: "normal", offset: 0, length: 2 },
        { weight: 700, style: "normal", offset: 2, length: 2 },
        { weight: 400, style: "italic", offset: 4, length: 2 },
      ]),
    );
    const bundle = new Uint8Array(4 + header.length + 6);
    new DataView(bundle.buffer).setUint32(0, header.length, true);
    bundle.set(header, 4);
    invoke.mockResolvedValue(bundle.buffer);
    return { fonts: await import("./fonts"), invoke, registered, load };
  }

  it("loads an unavailable family once across primary, fallback and UI, including regular/bold/italic", async () => {
    const { fonts, invoke, registered, load } = await resolver(false);
    const family = fonts.monoFontFamily("JetBrainsMono Nerd Font Mono");
    expect(family).toContain('"OpenIDEA User Font 0", "JetBrainsMono Nerd Font Mono"');
    fonts.uiFontFamily("jetbrainsmono nerd font mono");
    fonts.monoFontFamily("Inter", "JetBrainsMono Nerd Font Mono");
    await fonts.fontsLoaded(family, 14);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("user_font_data", { family: "JetBrainsMono Nerd Font Mono" });
    expect(registered.map((f) => f.descriptors)).toEqual([
      { weight: "400", style: "normal" },
      { weight: "700", style: "normal" },
      { weight: "400", style: "italic" },
    ]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses available local/system families without reading font data", async () => {
    const { fonts, invoke } = await resolver(true);
    expect(fonts.uiFontFamily("Menlo")).toBe('"Menlo", system-ui, sans-serif');
    fonts.monoFontFamily("Maple Mono NF CN");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not read a locally available symbol-only Nerd fallback", async () => {
    const { fonts, invoke } = await resolver("symbols");
    expect(fonts.familyFaces("Symbols Nerd Font Mono")).toEqual(['"Symbols Nerd Font Mono"']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never reads bundled webfonts even before their CSS faces load", async () => {
    const { fonts, invoke } = await resolver(false);
    fonts.monoFontFamily("Inter");
    fonts.monoFontFamily("JetBrains Mono");
    fonts.uiFontFamily("Inter Variable");
    fonts.monoFontFamily("JetBrains Mono Variable");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not read bundled faces or alter other platforms", async () => {
    const { fonts, invoke } = await resolver(false, "windows");
    fonts.monoFontFamily("Inter");
    fonts.monoFontFamily("JetBrains Mono");
    expect(fonts.uiFontFamily("User Font")).toBe('"User Font", system-ui, sans-serif');
    expect(invoke).not.toHaveBeenCalled();
  });
});
