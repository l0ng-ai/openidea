import { describe, expect, it } from "vitest";
import type { StubLink } from "@/platform/ipc";
import { linkAt } from "./pythonStubs";

const range = (start: number, end = start) => ({ start: { line: start, col: 0 }, end: { line: end, col: 0 } });
const link = (name: string, start: number, end: number): StubLink => ({
  name,
  range: range(start),
  extent: range(start, end),
  target: range(0),
});

describe("linkAt", () => {
  const links = [link("C", 4, 9), link("C.m", 6, 7), link("f", 11, 12)];

  it("picks the innermost declaration holding the line", () => {
    expect(linkAt(links, 7)?.name).toBe("C.m");
    expect(linkAt(links, 5)?.name).toBe("C");
    expect(linkAt(links, 12)?.name).toBe("f");
  });

  it("finds none outside every declaration", () => {
    expect(linkAt(links, 10)).toBeNull();
  });
});
