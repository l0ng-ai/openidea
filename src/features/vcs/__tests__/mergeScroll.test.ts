import { describe, expect, it } from "vitest";
import { ScrollEchoes } from "../mergeScroll";

describe("ScrollEchoes", () => {
  it("recognizes the scroll event a move causes, once", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("result", 120);
    // The browser may round the position it scrolled to.
    expect(echoes.take("result", 120.5)).toBe(true);
    // The next event of that pane is the user's.
    expect(echoes.take("result", 120.5)).toBe(false);
  });

  it("treats a pane the user scrolled past the move as the user's", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("theirs", 120);
    expect(echoes.take("theirs", 180)).toBe(false);
    expect(echoes.take("ours", 0)).toBe(false);
  });

  it("keeps moves of each pane apart", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("ours", 10);
    echoes.mark("theirs", 40);
    expect(echoes.take("theirs", 40)).toBe(true);
    expect(echoes.take("ours", 10)).toBe(true);
  });
});
