import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fileVariableDefinitions, variableAt } from "./variableNavigation";

const doc = Text.of([
  "@host = localhost:8080",
  "  @token=abc",
  "@hostname = other",
  "GET http://{{host}}/a?t={{ token }}&id={{$uuid}}",
  "Authorization: Bearer {{token}}",
]);
const offsetOf = (line: number, needle: string, delta = 0) =>
  doc.line(line).from + doc.line(line).text.indexOf(needle) + delta;

describe("http variable navigation", () => {
  it("finds the name of the {{variable}} under the caret", () => {
    expect(variableAt(doc, offsetOf(4, "host", 1))).toEqual({
      name: "host",
      from: offsetOf(4, "host"),
      to: offsetOf(4, "host") + 4,
    });
    // Spaces inside the braces are not part of the name.
    expect(variableAt(doc, offsetOf(4, "token", 2))?.name).toBe("token");
    expect(variableAt(doc, offsetOf(4, "{{ token", 2))).toBeNull();
    expect(variableAt(doc, offsetOf(4, "GET"))).toBeNull();
    // Dynamic variables have no definition.
    expect(variableAt(doc, offsetOf(4, "$uuid", 1))).toBeNull();
  });

  it("lists the file's @name definitions", () => {
    expect(fileVariableDefinitions(doc, "/p/a.http", "host")).toEqual([
      { path: "/p/a.http", range: { start: { line: 0, col: 1 }, end: { line: 0, col: 5 } } },
    ]);
    expect(fileVariableDefinitions(doc, "/p/a.http", "token")).toEqual([
      { path: "/p/a.http", range: { start: { line: 1, col: 3 }, end: { line: 1, col: 8 } } },
    ]);
    expect(fileVariableDefinitions(doc, "/p/a.http", "missing")).toEqual([]);
  });
});
