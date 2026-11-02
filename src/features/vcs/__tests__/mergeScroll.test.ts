import { describe, expect, it } from "vitest";
import { syncScrollTargets } from "../mergeScroll";

const info = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe("syncScrollTargets", () => {
  it("maps the source ratio onto each target's own range", () => {
    const source = info(400, 2000, 500);
    expect(syncScrollTargets(source, [info(0, 1000, 200), info(0, 3000, 500)])).toEqual([
      (400 / 1500) * 800,
      (400 / 1500) * 2500,
    ]);
  });

  it("returns null when the source pane cannot scroll", () => {
    // A short document: syncing from it would read the ratio as 0 and pull
    // every pane to the top while the user scrolls the others (issue #790).
    expect(syncScrollTargets(info(0, 500, 500), [info(400, 2000, 500)])).toBeNull();
  });

  it("targets the top for panes without a scroll range", () => {
    expect(syncScrollTargets(info(100, 2000, 500), [info(0, 500, 500)])).toEqual([0]);
  });
});
