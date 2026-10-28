import { describe, expect, it } from "vitest";
import { groupJump, type SeRow } from "../everywhere/model";

const section = (id: string) => ({ kind: "section", key: `#${id}`, section: id, title: id }) as unknown as SeRow;
const more = (id: string) => ({ kind: "more", key: `more:${id}`, section: id }) as unknown as SeRow;
const item = (key: string, id: string) => ({ kind: "file", key, section: id }) as unknown as SeRow;

// 0 Classes, 1 a, 2 b, 3 Files, 4 c, 5 more, 6 Actions, 7 d
const rows = [
  section("classes"),
  item("a", "classes"),
  item("b", "classes"),
  section("files"),
  item("c", "files"),
  more("files"),
  section("actions"),
  item("d", "actions"),
];

describe("groupJump", () => {
  it("moves to the first item of the next group", () => {
    expect(groupJump(rows, 1, 1)).toBe(4);
    expect(groupJump(rows, 5, 1)).toBe(7);
    expect(groupJump(rows, 7, 1)).toBe(7);
  });

  it("moves to the start of the current group, then the previous one", () => {
    expect(groupJump(rows, 5, -1)).toBe(4);
    expect(groupJump(rows, 4, -1)).toBe(1);
    expect(groupJump(rows, 2, -1)).toBe(1);
  });

  it("finds groups without header rows", () => {
    const flat = [item("a", "classes"), item("b", "classes"), item("c", "files")];
    expect(groupJump(flat, 0, 1)).toBe(2);
    expect(groupJump(flat, 2, -1)).toBe(0);
  });

  it("is null with a single group", () => {
    expect(groupJump([item("a", "files"), item("b", "files")], 0, 1)).toBeNull();
  });
});
