import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeDesktopBase64 } from "@/platform/desktopFiles";
import { commands } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { MAX_PLOTS, addPlot, clearPlots, removePlot, savePlot, usePlots } from "./store";

vi.mock("@/platform/dialog", () => ({ save: async () => "/out/plot.png" }));
vi.mock("@/platform/desktopFiles", () => ({ writeDesktopBase64: vi.fn(async () => {}) }));

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

  it("saves the figure's PNG bytes and reports a failure", async () => {
    const notes: string[] = [];
    provideNotificationService({ notify: (n) => void notes.push(`${n.level}: ${n.title}`) });
    const read = vi
      .spyOn(commands, "fsReadImage")
      .mockResolvedValue({ status: "ok", data: "data:image/png;base64,UE5H" });
    await savePlot("/p/a.png");
    expect(read).toHaveBeenCalledWith("/p/a.png");
    expect(writeDesktopBase64).toHaveBeenCalledWith("/out/plot.png", "UE5H");
    expect(notes).toEqual([]);

    read.mockResolvedValueOnce({ status: "error", error: { kind: "internal", message: "gone", data: null } });
    await savePlot("/p/a.png");
    expect(notes).toEqual(["error: Cannot save the plot"]);
  });
});
