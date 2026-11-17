import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `gap` takes the spacing scale in tokens.css; these literals have a token.
const SCALED = /(?:^|[;{\s])(?:row-|column-)?gap\s*:\s*[^;}]*\b(?:2|4|6|8|12|16)px\b/g;

describe("spacing scale", () => {
  it("gap uses --space-* tokens for on-scale values", () => {
    const offenders: string[] = [];
    for (const file of globSync("src/**/*.css")) {
      if (file.endsWith("styles/tokens.css")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(SCALED)) {
        offenders.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
