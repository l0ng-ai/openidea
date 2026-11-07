import { describe, expect, it } from "vitest";
import { classMembers, enclosingClass, memberStubs } from "./members";

const src = `from abc import ABC, abstractmethod


class Shape(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def area(
        self, scale: float = 1.0
    ) -> float:
        """Area."""

    def describe(self) -> str:
        return self.name


class Square(Shape):
    def __init__(self, side: float):
        self.side = side
`.split("\n");

describe("python members", () => {
  it("finds the class enclosing a line", () => {
    expect(enclosingClass(src, 4)).toBe(4);
    expect(enclosingClass(src, 13)).toBe(4);
    expect(enclosingClass(src, 21)).toBe(19);
    expect(enclosingClass(src, 1)).toBeNull();
  });

  it("lists methods with their decorators and signatures", () => {
    const members = classMembers(src, 4);
    expect(members.map((m) => [m.name, m.abstract])).toEqual([
      ["name", true],
      ["area", true],
      ["describe", false],
    ]);
    expect(members[0]!.lines).toEqual(["@property", "def name(self) -> str:"]);
    expect(members[1]!.lines).toEqual(["def area(", "    self, scale: float = 1.0", ") -> float:"]);
  });

  it("stops at a nested class without bases", () => {
    const nested = ["class Outer(Base):", "    class Inner:", "        x = 1", ""];
    expect(enclosingClass(nested, 3)).toBeNull();
  });

  it("keeps a body going through an unindented string", () => {
    const lines = [
      "class A(ABC):",
      "    @abc.abstractproperty",
      "    def doc(self):",
      '        return """',
      "text",
      '"""',
      "    @abstractmethod",
      "    def run(self): ...",
      "x = 1",
    ];
    const members = classMembers(lines, 1);
    expect(members.map((m) => m.lines)).toEqual([["@property", "def doc(self):"], ["def run(self):"]]);
    expect(members.every((m) => m.abstract)).toBe(true);
  });

  it("writes stubs at the body's indentation", () => {
    const [name] = classMembers(src, 4);
    expect(memberStubs([name!], "    ", "    ")).toBe("    @property\n    def name(self) -> str:\n        pass");
  });
});
