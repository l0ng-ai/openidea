import { describe, expect, it } from "vitest";
import { intelliSortBlock } from "./intelliSort";

describe("IntelliSort Java import options", () => {
  it("keeps single-class imports below the wildcard threshold", () => {
    const block = "import java.util.List;\nimport java.util.Map;";
    expect(intelliSortBlock(block, { classCountToUseImportWithWildcard: 5 })).toBe(block);
  });

  it("collapses repeated classes of a package into one wildcard", () => {
    const block = ["import java.util.List;", "import java.util.Map;", "import java.util.Set;"].join("\n");
    expect(intelliSortBlock(block, { classCountToUseImportWithWildcard: 3 })).toBe("import java.util.*;");
  });

  it("moves static imports ahead of ordinary ones when configured", () => {
    const block = [
      "import java.util.List;",
      "import static java.util.Collections.emptyList;",
      "import static java.util.Arrays.asList;",
    ].join("\n");
    expect(intelliSortBlock(block, { keepStaticImportsFirst: true })).toBe(
      "import static java.util.Collections.emptyList;\nimport static java.util.Arrays.asList;\nimport java.util.List;",
    );
  });

  it("leaves non-import lines untouched", () => {
    const block = "package demo;\n\nimport java.util.List;";
    expect(intelliSortBlock(block, { keepStaticImportsFirst: true })).toBe(block);
  });
});
