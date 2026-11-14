import { describe, expect, it } from "vitest";
import { closeSelectedContent, contentTabRegistry, togglePinSelectedContent } from "./content";

describe("tool window content tabs", () => {
  it("closes the selected tab of the first strip that can, else reports false", () => {
    const closed: string[] = [];
    const register = contentTabRegistry("run");
    expect(contentTabRegistry("run")).toBe(register);
    const disposeA = register({ closeSelected: () => false, togglePinSelected: () => false });
    const disposeB = register({ closeSelected: () => (closed.push("b"), true), togglePinSelected: () => false });
    expect(closeSelectedContent("run")).toBe(true);
    expect(closed).toEqual(["b"]);
    disposeB();
    expect(closeSelectedContent("run")).toBe(false);
    disposeA();
    expect(closeSelectedContent("other")).toBe(false);
  });

  it("pins the selected tab of the first strip that can, else reports false", () => {
    const pinned: string[] = [];
    const register = contentTabRegistry("find");
    const disposeA = register({ closeSelected: () => false, togglePinSelected: () => false });
    const disposeB = register({ closeSelected: () => false, togglePinSelected: () => (pinned.push("b"), true) });
    expect(togglePinSelectedContent("find")).toBe(true);
    expect(pinned).toEqual(["b"]);
    disposeB();
    expect(togglePinSelectedContent("find")).toBe(false);
    disposeA();
  });
});
