import { describe, expect, it } from "vitest";
import { targetLabel } from "./files";

describe("targetLabel", () => {
  const at = (line: string, needle: string) => targetLabel(line, line.indexOf(needle));

  it.each([
    // Spring configuration consumers start at the string literal, not a name.
    ['    @Value("${app.name}") private String appName;', '"${app', '"${app.name}"'],
    ["    @Value('${app.name}') String appName", "'${app", "'${app.name}'"],
    ["  const key = `app.${env}`;", "`app", "`app.${env}`"],
    ['    String s = "say \\"hi\\"" + x;', '"say', '"say \\"hi\\""'],
    // Unterminated (multi-line) literals end at the line end.
    ['    String block = "unterminated', '"unterminated', '"unterminated'],
    // Ordinary declarations keep the identifier.
    ["    private String appName;", "appName", "appName"],
    ["  public int getTimeOut() { return timeOut; }", "getTimeOut", "getTimeOut"],
    ["  int $inner = 1;", "$inner", "$inner"],
    ["  time-out: 30", "time", "time"],
  ])("%s", (line, needle, expected) => {
    expect(at(line, needle)).toBe(expected);
  });

  it("shortens long literals", () => {
    const line = `x("${"a".repeat(100)}")`;
    const label = targetLabel(line, 2)!;
    expect(label).toHaveLength(60);
    expect(label.endsWith("…")).toBe(true);
  });

  it("has no label for empty literals, numbers or blank positions", () => {
    expect(targetLabel('  x = "";', 6)).toBeNull();
    expect(targetLabel("  port: 8080", 8)).toBeNull();
    expect(targetLabel("   ", 1)).toBeNull();
  });
});
