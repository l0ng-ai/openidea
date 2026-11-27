/** The Plots tool window's figures (PNG files the matplotlib backend saved), oldest first. */
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { writeClipboardPng } from "@/platform/clipboard";
import { writeDesktopBase64 } from "@/platform/desktopFiles";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

interface PlotsState {
  plots: string[];
  selected: string | null;
}

export const usePlots = create<PlotsState>(() => ({ plots: [], selected: null }));

/** Shows a new figure; false when it is already listed (the watcher reports a file more than once). */
export function addPlot(path: string): boolean {
  const { plots } = usePlots.getState();
  if (plots.includes(path)) return false;
  usePlots.setState({ plots: [...plots, path], selected: path });
  return true;
}

/** Removes a figure from the list and selects its neighbour. */
export function removePlot(path: string) {
  const { plots, selected } = usePlots.getState();
  const at = plots.indexOf(path);
  const rest = plots.filter((p) => p !== path);
  usePlots.setState({
    plots: rest,
    selected: selected === path ? (rest[Math.min(at, rest.length - 1)] ?? null) : selected,
  });
}

export const clearPlots = () => usePlots.setState({ plots: [], selected: null });

const failed = (title: string) => (e: unknown) =>
  notifications().notify({ level: "error", title, body: e instanceof Error ? e.message : String(e) });

export async function savePlot(path: string) {
  const { save } = await import("@/platform/dialog");
  const to = await save({
    title: tx("Save Plot"),
    defaultPath: "plot.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!to) return;
  const url = await call(commands.fsReadImage(path));
  await writeDesktopBase64(to, url.slice(url.indexOf(",") + 1)).catch(failed(tx("Cannot save the plot")));
}

export function copyPlot(path: string) {
  const png = call(commands.fsReadImage(path))
    .then((url) => fetch(url))
    .then((r) => r.blob());
  void writeClipboardPng(png).catch(failed(tx("Cannot copy the plot")));
}
