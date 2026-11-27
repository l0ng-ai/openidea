import { beforeEach, describe, expect, it } from "vitest";
import { addPlot, clearPlots, removePlot, usePlots } from "./store";

describe("plots", () => {
  beforeEach(clearPlots);

  it("lists each figure once and selects the newest", () => {
    expect([addPlot("/p/a.png"), addPlot("/p/b.png"), addPlot("/p/a.png")]).toEqual([true, true, false]);
    expect(usePlots.getState()).toEqual({ plots: ["/p/a.png", "/p/b.png"], selected: "/p/b.png" });
  });

  it("selects a neighbour of the deleted figure", () => {
    ["/p/a.png", "/p/b.png", "/p/c.png"].forEach(addPlot);
    usePlots.setState({ selected: "/p/b.png" });
    removePlot("/p/b.png");
    expect(usePlots.getState().selected).toBe("/p/c.png");
    removePlot("/p/c.png");
    expect(usePlots.getState().selected).toBe("/p/a.png");
    removePlot("/p/a.png");
    expect(usePlots.getState()).toEqual({ plots: [], selected: null });
  });
});
