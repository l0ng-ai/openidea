import { describe, expect, it } from "vitest";
import { segmentLine } from "./segments";

describe("segmentLine marks", () => {
  it("splits a line around matches", () => {
    expect(
      segmentLine(
        [{ text: "hello world" }],
        [],
        [
          { start: 0, end: 5 },
          { start: 6, end: 11 },
        ],
      ),
    ).toEqual([
      { text: "hello", style: {}, mark: true, current: false },
      { text: " ", style: {} },
      { text: "world", style: {}, mark: true, current: false },
    ]);
  });

  it("marks the current match and keeps its span style", () => {
    expect(segmentLine([{ text: "red", fg: "#f00" }], [], [{ start: 0, end: 3, current: true }])).toEqual([
      { text: "red", style: { fg: "#f00" }, mark: true, current: true },
    ]);
  });

  it("splits matches inside links", () => {
    const link = { kind: "url" as const, url: "http://x", text: "http://x", start: 4, end: 12 };
    expect(segmentLine([{ text: "see http://x" }], [link], [{ start: 8, end: 12 }])).toEqual([
      { text: "see ", style: {} },
      { text: "http", style: {}, link },
      { text: "://x", style: {}, link, mark: true, current: false },
    ]);
  });
});
