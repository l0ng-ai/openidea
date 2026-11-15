import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fileReferenceAt } from "./fileNavigation";

const doc = Text.of([
  "POST http://x/api",
  "",
  "< ./body.json",
  "> handler.js",
  "> {% client.test('ok', () => {}); %}",
  ">> out/result.json",
  "<> 2026-11-10T135253.200.json",
]);
const at = (line: number, col: number) => fileReferenceAt(doc, doc.line(line).from + col);

describe("fileReferenceAt", () => {
  it("finds the file a body, handler, redirect or saved-response line names", () => {
    expect(at(3, 4)).toMatchObject({ value: "./body.json", response: false });
    expect(at(4, 3)).toMatchObject({ value: "handler.js", response: false });
    expect(at(6, 5)).toMatchObject({ value: "out/result.json", response: false });
    expect(at(7, 10)).toMatchObject({ value: "2026-11-10T135253.200.json", response: true });
  });

  it("ignores inline handler scripts, the marker itself and other lines", () => {
    expect(at(5, 6)).toBeNull();
    expect(at(7, 0)).toBeNull();
    expect(at(1, 6)).toBeNull();
  });
});
