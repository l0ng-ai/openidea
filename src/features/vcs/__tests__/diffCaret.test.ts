import { afterEach, expect, it } from "vitest";
import { diffInput, diffInputAtCaret, rememberDiffCaret, type DiffData } from "../diffInput";

const data: DiffData = {
  path: "/p/a.ts",
  left: { type: "text", text: "a\n", label: "HEAD" },
  right: { type: "text", text: "b\n", label: "Working tree" },
  reveal: "first",
};

afterEach(() => rememberDiffCaret(diffInput(data).key, 0, 0, "right"));

it("reopens a diff at its last caret (line, column and side) instead of its first difference", () => {
  const input = diffInput(data);
  rememberDiffCaret(input.key, 12, 9, "left");
  const reopened = diffInputAtCaret(input);
  expect(reopened.key).toBe(input.key);
  expect(reopened.data).toMatchObject({ line: 12, col: 9, lineSide: "left" });
  expect((reopened.data as DiffData).reveal).toBeUndefined();
});

it("leaves a diff without a remembered caret as it is", () => {
  const input = diffInput({ ...data, path: "/p/other.ts" });
  expect(diffInputAtCaret(input)).toBe(input);
});
