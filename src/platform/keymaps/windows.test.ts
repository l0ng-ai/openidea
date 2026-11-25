import { afterEach, describe, expect, it } from "vitest";
import { usePlatform } from "../platformInfo";
import { defaultPreset, formatBinding, hasPrimaryModifier, hostBinding, macStroke } from "../keymap";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";
import { vscodeMacos } from "./vscode-macos";
import { vscodeWindows } from "./vscode-windows";

const usesMeta = (km: Record<string, string[]>) =>
  Object.entries(km).filter(([, keys]) => keys.some((k) => /\bMeta\b/.test(k)));

describe("Windows keymaps", () => {
  it("cover the same actions as their macOS presets", () => {
    expect(Object.keys(intellijWindows).sort()).toEqual(Object.keys(intellijMacos).sort());
    expect(Object.keys(vscodeWindows).sort()).toEqual(Object.keys(vscodeMacos).sort());
  });

  it("never bind the Windows key", () => {
    expect(usesMeta(intellijWindows)).toEqual([]);
    expect(usesMeta(vscodeWindows)).toEqual([]);
  });

  it.each([
    ["navigate.gotoFile", "Ctrl+Shift+N"],
    ["navigate.findAction", "Ctrl+Shift+A"],
    ["file.settings", "Ctrl+Alt+S"],
    ["run.run", "Shift+F10"],
    ["code.commentLine", "Ctrl+/"],
  ])("IDEA %s → %s", (id, key) => expect(intellijWindows[id]).toEqual([key]));

  it("cycles the case of an identifier with ⇧⌥U in both IDEA presets", () => {
    expect(intellijWindows["code.cycleCase"]).toEqual(["Alt+Shift+U"]);
    expect(intellijMacos["code.cycleCase"]).toEqual(["Alt+Shift+U"]);
  });

  it("VS Code reads ⌘ as Ctrl", () => {
    expect(vscodeWindows["navigate.gotoFile"]).toEqual(["Ctrl+P"]);
    expect(vscodeWindows["code.quickDocumentation"]).toEqual(["Ctrl+K Ctrl+I"]);
  });

  it("scrolls the editor a line with Ctrl+↑ / Ctrl+↓ in VS Code", () => {
    expect(vscodeWindows["editor.scrollUp"]).toEqual(["Ctrl+Up"]);
    expect(vscodeWindows["editor.scrollDown"]).toEqual(["Ctrl+Down"]);
  });
});

describe("host modifier helpers", () => {
  afterEach(() => usePlatform.setState({ os: "macos" }));

  it("macOS keeps ⌘", () => {
    usePlatform.setState({ os: "macos" });
    expect(defaultPreset()).toBe("intellij-macos");
    expect(formatBinding("Meta+Shift+O")).toBe("⇧⌘O");
    expect(hostBinding("Meta+C")).toBe("Meta+C");
    expect(macStroke("Ctrl+C")).toBe("Ctrl+C");
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false })).toBe(true);
  });

  it("Windows uses Ctrl and spells shortcuts out", () => {
    usePlatform.setState({ os: "windows" });
    expect(defaultPreset()).toBe("intellij-windows");
    expect(formatBinding("Ctrl+Shift+N")).toBe("Ctrl+Shift+N");
    expect(formatBinding("Ctrl+K Ctrl+I")).toBe("Ctrl+K, Ctrl+I");
    expect(formatBinding("Shift Shift")).toBe("Shift, Shift");
    expect(hostBinding("Meta+Shift+C")).toBe("Ctrl+Shift+C");
    expect(macStroke("Ctrl+Shift+C")).toBe("Shift+Meta+C");
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});
