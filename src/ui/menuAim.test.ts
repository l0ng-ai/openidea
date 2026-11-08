import { describe, expect, it } from "vitest";
import { isSubmenuAim } from "./menuAim";

describe("isSubmenuAim", () => {
  const right = { left: 182, right: 362, top: 6, bottom: 150 };

  it("accepts diagonal movement toward either near corner and the gap", () => {
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 100, y: 45 }, right)).toBe(true);
    expect(isSubmenuAim({ x: 50, y: 80 }, { x: 100, y: 55 }, right)).toBe(true);
    expect(isSubmenuAim({ x: 170, y: 40 }, { x: 181, y: 60 }, right)).toBe(true);
    expect(isSubmenuAim({ x: 170, y: 40 }, { x: 182, y: 155 }, right)).toBe(true);
  });

  it("rejects movement away, outside the triangle, or beyond the submenu", () => {
    expect(isSubmenuAim({ x: 100, y: 45 }, { x: 60, y: 45 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 60, y: 100 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 50, y: 35 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 400, y: 45 }, right)).toBe(false);
  });

  it("uses the right edge of a submenu flipped to the left", () => {
    const left = { left: 6, right: 180, top: 6, bottom: 150 };
    expect(isSubmenuAim({ x: 300, y: 20 }, { x: 250, y: 45 }, left)).toBe(true);
    expect(isSubmenuAim({ x: 250, y: 45 }, { x: 300, y: 45 }, left)).toBe(false);
  });

  it("rejects a first move, a stationary pointer and degenerate triangles", () => {
    expect(isSubmenuAim(null, { x: 100, y: 45 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 50, y: 20 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 182, y: 20 }, { x: 182, y: 45 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 200, y: 20 }, { x: 210, y: 45 }, right)).toBe(false);
    expect(isSubmenuAim({ x: 50, y: 20 }, { x: 100, y: 45 }, { ...right, bottom: 6 })).toBe(false);
  });
});
