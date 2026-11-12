import { afterEach, describe, expect, it, vi } from "vitest";
import { monoFontFamily, quoteFontFamily, resolveMonoFont, uiFontFamily } from "./fonts";

const BASE = "var(--font-mono)";

describe("monoFontFamily", () => {
  it.each([
    // #26: the default family names the bundled face, so it renders without a system install.
    // #2305: the installed family comes first, so its hinted outlines render like IDEA's.
    ["JetBrains Mono", "", `"JetBrains Mono", "JetBrains Mono Variable", ${BASE}`],
    ["", "", `"JetBrains Mono", "JetBrains Mono Variable", ${BASE}`],
    [undefined, "", `"JetBrains Mono", "JetBrains Mono Variable", ${BASE}`],
    ["JetBrains Mono", "PingFang SC", `"JetBrains Mono", "JetBrains Mono Variable", "PingFang SC", ${BASE}`],
    ["Inter", "", `"Inter", "Inter Variable", ${BASE}`],
    ["Fira Code", "Inter", `"Fira Code", "Inter", "Inter Variable", ${BASE}`],
    ["Inter", "JetBrains Mono", `"Inter", "Inter Variable", "JetBrains Mono", "JetBrains Mono Variable", ${BASE}`],
    ["inter", "jetbrains mono", `"Inter", "Inter Variable", "JetBrains Mono", "JetBrains Mono Variable", ${BASE}`],
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
    ["Inter", "", '"Inter", "Inter Variable", system-ui, sans-serif'],
    ["JetBrains Mono", "", '"JetBrains Mono", "JetBrains Mono Variable", system-ui, sans-serif'],
    [' "PingFang SC" ', "", '"PingFang SC", system-ui, sans-serif'],
    ["Inter", "思源黑体", '"Inter", "Inter Variable", "思源黑体", system-ui, sans-serif'],
    ["Inter", " ", '"Inter", "Inter Variable", system-ui, sans-serif'],
  ])("%j + %j", (family, fallback, expected) => {
    expect(uiFontFamily(family, fallback)).toBe(expected);
  });
});

describe("resolveMonoFont", () => {
  const terminal = {
    useEditorFont: true,
    fontFamily: "JetBrains Mono",
    fallbackFontFamily: "",
    fontSize: 13,
  };
  const editor = { fontFamily: "Fira Code", fallbackFont: "PingFang SC", fontSize: 16 };

  it("follows Editor › Font while Use editor font is on", () => {
    expect(resolveMonoFont(terminal, editor, BASE)).toEqual({
      family: `"Fira Code", "PingFang SC", ${BASE}`,
      size: 16,
    });
  });

  it("uses the terminal's own family, fallback and size when it is off", () => {
    expect(
      resolveMonoFont(
        { ...terminal, useEditorFont: false, fontFamily: "Hack", fallbackFontFamily: "Maple Mono NF CN", fontSize: 14 },
        editor,
        BASE,
      ),
    ).toEqual({ family: `"Hack", "Maple Mono NF CN", ${BASE}`, size: 14 });
  });

  it("prefers the terminal's fallback over the editor's while following the editor font", () => {
    expect(resolveMonoFont({ ...terminal, fallbackFontFamily: "Maple Mono NF CN" }, editor, BASE).family).toBe(
      `"Fira Code", "Maple Mono NF CN", ${BASE}`,
    );
  });

  it("falls back to the bundled family and 13px without settings", () => {
    expect(resolveMonoFont(undefined, undefined, BASE)).toEqual({
      family: `"JetBrains Mono", "JetBrains Mono Variable", ${BASE}`,
      size: 13,
    });
  });
});

describe("macOS user font resolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function resolver(available: boolean | "symbols" | "connected", os = "macos") {
    vi.resetModules();
    const invoke = vi.fn();
    vi.doMock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
    vi.doMock("./platformInfo", () => ({ guessOs: () => os }));
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const isConnected = () => this.isConnected;
      canvases.push(this);
      return {
        font: "",
        measureText(this: { font: string }, text: string) {
          const covered =
            available === true ||
            (available === "symbols" && text.includes("\uF418")) ||
            (available === "connected" && isConnected());
          return { width: covered && this.font.includes('"') ? 200 : 100 };
        },
      } as unknown as CanvasRenderingContext2D;
    });
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
    return { fonts: await import("./fonts"), invoke, registered, load, canvases };
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

  it("loads a UI fallback through the shared macOS user font resolver", async () => {
    const { fonts, invoke, registered } = await resolver(false);
    const family = fonts.uiFontFamily("Inter", "Maple Mono NF CN");
    expect(family).toBe('"Inter", "Inter Variable", "OpenIDEA User Font 0", "Maple Mono NF CN", system-ui, sans-serif');
    expect(fonts.monoFontFamily("Inter", "Maple Mono NF CN")).toContain('"OpenIDEA User Font 0"');
    await fonts.fontsLoaded(family, 13);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("user_font_data", { family: "Maple Mono NF CN" });
    expect(registered).toHaveLength(3);
  });

  it("detects user fonts that WKWebView exposes only to connected canvases without loading bytes", async () => {
    const { fonts, invoke, canvases } = await resolver("connected");
    expect(fonts.fontAvailable("Maple Mono NF CN")).toBe(true);
    expect(fonts.familyFaces("Maple Mono NF CN")).toEqual(['"Maple Mono NF CN"']);
    expect(fonts.familyFaces("JetBrainsMono Nerd Font Mono")).toEqual(['"JetBrainsMono Nerd Font Mono"']);
    expect(invoke).not.toHaveBeenCalled();
    expect(canvases.length).toBeGreaterThan(0);
    expect(canvases.every((canvas) => canvas.hidden && !canvas.isConnected)).toBe(true);
  });

  it("removes the probe when a font is unavailable or canvas measurement fails", async () => {
    const { fonts, canvases } = await resolver(false);
    expect(fonts.fontAvailable("Unavailable")).toBe(false);
    expect(canvases.every((canvas) => !canvas.isConnected)).toBe(true);
    const remove = vi.spyOn(HTMLCanvasElement.prototype, "remove");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("Canvas unavailable");
    });
    expect(fonts.fontAvailable("Maple Mono NF CN")).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
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
