import { describe, expect, it } from "vitest";
import { consoleFontOf } from "./consoleFont";

const terminal = (useEditorFont: boolean) => ({
  useEditorFont,
  fontFamily: "Menlo",
  fallbackFontFamily: "",
  fontSize: 13,
});
const editor = { fontFamily: "Fira Code", fontSize: 15, fontWeight: 500, boldFontWeight: 800 };

describe("console font", () => {
  it("uses the editor's weights when the terminal follows the editor font", () => {
    const font = consoleFontOf(terminal(true), editor);
    expect(font).toMatchObject({ size: 15, weight: 500, boldWeight: 800 });
    expect(font.family).toContain("Fira Code");
  });

  it("uses regular and bold with the terminal's own font, as the terminal does", () => {
    const font = consoleFontOf(terminal(false), editor);
    expect(font).toMatchObject({ size: 13, weight: 400, boldWeight: 700 });
    expect(font.family).toContain("Menlo");
  });
});
