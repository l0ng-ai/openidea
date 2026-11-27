import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { MAX_PLOTS, addPlot, clearPlots, removePlot, usePlots } from "./store";

const deleted = vi.spyOn(commands, "plotsDelete").mockResolvedValue({ status: "ok", data: null });

describe("plots", () => {
  beforeEach(() => {
    clearPlots();
    deleted.mockClear();
  });

  it("lists each figure once and selects the newest", () => {
    expect([addPlot("/p/a.png"), addPlot("/p/b.png"), addPlot("/p/a.png")]).toEqual([true, true, false]);
    expect(usePlots.getState()).toEqual({ plots: ["/p/a.png", "/p/b.png"], selected: "/p/b.png" });
    expect(deleted).not.toHaveBeenCalled();
  });

  it("deletes a figure's file and selects a neighbour", () => {
    ["/p/a.png", "/p/b.png", "/p/c.png"].forEach(addPlot);
    usePlots.setState({ selected: "/p/b.png" });
    removePlot("/p/b.png");
    expect(usePlots.getState().selected).toBe("/p/c.png");
    expect(deleted).toHaveBeenLastCalledWith(["/p/b.png"]);
    removePlot("/p/c.png");
    expect(usePlots.getState().selected).toBe("/p/a.png");
    clearPlots();
    expect(usePlots.getState()).toEqual({ plots: [], selected: null });
    expect(deleted).toHaveBeenLastCalledWith(["/p/a.png"]);
  });

  it("keeps the newest figures and deletes the files of older ones", () => {
    for (let i = 0; i <= MAX_PLOTS; i++) addPlot(`/p/${i}.png`);
    const { plots } = usePlots.getState();
    expect([plots.length, plots[0], plots.at(-1)]).toEqual([MAX_PLOTS, "/p/1.png", `/p/${MAX_PLOTS}.png`]);
    expect(deleted).toHaveBeenCalledWith(["/p/0.png"]);
  });
});
