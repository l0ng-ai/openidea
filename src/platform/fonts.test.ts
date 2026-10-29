import { describe, expect, it } from "vitest";
import { monoFontFamily, uiFontFamily } from "./fonts";

const BASE = "var(--font-mono)";

describe("monoFontFamily", () => {
  it.each([
    // #26: the default family names the bundled face, so it renders without a system install.
    ["JetBrains Mono", "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["", "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    [undefined, "", `"JetBrains Mono Variable", "JetBrains Mono", ${BASE}`],
    ["JetBrains Mono", "PingFang SC", `"JetBrains Mono Variable", "JetBrains Mono", "PingFang SC", ${BASE}`],
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

describe("uiFontFamily", () => {
  it.each([
    ["Inter", '"Inter Variable", "Inter", system-ui, sans-serif'],
    ["JetBrains Mono", '"JetBrains Mono Variable", "JetBrains Mono", system-ui, sans-serif'],
    [' "PingFang SC" ', '"PingFang SC", system-ui, sans-serif'],
  ])("%j", (family, expected) => {
    expect(uiFontFamily(family)).toBe(expected);
  });
});
