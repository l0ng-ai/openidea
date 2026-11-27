import { describe, expect, it } from "vitest";
import { EXCERPT_LINES, failureDraft, isTestFailure } from "./testFailure";

describe("Diagnose with Agent draft (#4716)", () => {
  it("names the test, its source reference and the compared values", () => {
    const draft = failureDraft(
      {
        name: "OrderControllerTest > creates()",
        expected: "201",
        actual: "403",
        output: ["", "Status expected:<201> but was:<403>", ""],
      },
      "@src/test/java/OrderControllerTest.java:42",
    );
    expect(draft).toBe(
      [
        "The test OrderControllerTest > creates() failed. Help me find out why.",
        "Test source: @src/test/java/OrderControllerTest.java:42",
        "Expected: 201\nActual: 403",
        "```\nStatus expected:<201> but was:<403>\n```",
      ].join("\n\n"),
    );
  });

  it("shortens a long excerpt and says how much it left out", () => {
    const output = Array.from({ length: EXCERPT_LINES + 5 }, (_, i) => `at frame${i}`);
    const draft = failureDraft({ name: "t", output }, undefined);
    expect(draft).toContain(`at frame${EXCERPT_LINES - 1}\n… 5 more lines\n\`\`\``);
    expect(draft).not.toContain(`at frame${EXCERPT_LINES}\n`);
    expect(draft).not.toContain("Test source");
  });

  it("fences output that holds backticks with a longer fence", () => {
    expect(failureDraft({ name: "t", output: ["```js", "x"] }, undefined)).toContain("````\n```js\nx\n````");
  });

  it("accepts only a failure argument", () => {
    expect(isTestFailure({ name: "t", output: [] })).toBe(true);
    expect(isTestFailure(undefined)).toBe(false);
    expect(isTestFailure({ name: "t" })).toBe(false);
  });
});
