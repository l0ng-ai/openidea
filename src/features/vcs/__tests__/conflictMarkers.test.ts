import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { markerDiagnostics } from "../conflictMarkers";

const doc = (s: string) => Text.of(s.split("\n"));

describe("markerDiagnostics", () => {
  it("reports an error on every marker line of a conflict, whatever the language", () => {
    const text = "def allServices = [\n<<<<<<< Updated upstream\n  'a',\n=======\n  'b',\n>>>>>>> Stashed changes\n]\n";
    const found = markerDiagnostics(doc(text));
    expect(found.map((d) => [d.range.start.line, d.range.end.line, d.severity])).toEqual([
      [1, 1, "error"],
      [3, 3, "error"],
      [5, 5, "error"],
    ]);
    expect(found[0]!.range.end.col).toBe("<<<<<<< Updated upstream".length);
    expect(found.every((d) => d.message === "Unresolved merge conflict marker" && d.source === "Git")).toBe(true);
  });

  it("includes the base marker of a diff3 conflict", () => {
    const text = "<<<<<<< a\nx\n||||||| base\nb\n=======\ny\n>>>>>>> c\n";
    expect(markerDiagnostics(doc(text))).toHaveLength(4);
  });

  it("uses UTF-16 columns and excludes CRLF terminators", () => {
    const found = markerDiagnostics(doc("😀\r\n<<<<<<< ours 😀\r\nx\r\n=======\r\ny\r\n>>>>>>> theirs\r\n"));
    expect(found[0]!.range).toEqual({ start: { line: 1, col: 0 }, end: { line: 1, col: 15 } });
    expect(found[1]!.range).toEqual({ start: { line: 3, col: 0 }, end: { line: 3, col: 7 } });
  });

  it("skips oversized documents without flattening their text", () => {
    const large = doc("x".repeat(2_000_001));
    const flatten = vi.spyOn(large, "toString");
    expect(markerDiagnostics(large)).toEqual([]);
    expect(flatten).not.toHaveBeenCalled();
  });

  it("reports nothing for text without conflicts, or a block that was never closed", () => {
    expect(markerDiagnostics(doc("a\nb\n"))).toEqual([]);
    expect(markerDiagnostics(doc("<<<<<<< a\nx\n=======\ny\n"))).toEqual([]);
    // A heading underline of seven equals signs is not a conflict.
    expect(markerDiagnostics(doc("Title\n=======\ntext\n"))).toEqual([]);
  });
});
