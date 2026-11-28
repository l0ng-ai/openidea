/** The Plots tool window's figures (PNG files the matplotlib backend saved), oldest first. */
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { writeClipboardPng } from "@/platform/clipboard";
import { writeDesktopBase64 } from "@/platform/desktopFiles";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

/** The window keeps this many figures; a run that shows more drops (and deletes) the oldest. */
export const MAX_PLOTS = 100;

interface PlotsState {
  plots: string[];
  selected: string | null;
}

export const usePlots = create<PlotsState>(() => ({ plots: [], selected: null }));

/** The files of figures the window no longer lists; failures only leave a file in the cache. */
function deleteFiles(paths: string[]) {
  if (paths.length) void call(commands.plotsDelete(paths)).catch(() => {});
}

/** Shows a new figure; false when it is already listed (the watcher reports a file more than once). */
export function addPlot(path: string): boolean {
  const { plots } = usePlots.getState();
  if (plots.includes(path)) return false;
  const all = [...plots, path];
  const dropped = all.slice(0, Math.max(0, all.length - MAX_PLOTS));
  usePlots.setState({ plots: all.slice(dropped.length), selected: path });
  deleteFiles(dropped);
  return true;
}

/** Deletes a figure and selects its neighbour. */
export function removePlot(path: string) {
  const { plots, selected } = usePlots.getState();
  const at = plots.indexOf(path);
  const rest = plots.filter((p) => p !== path);
  usePlots.setState({
    plots: rest,
    selected: selected === path ? (rest[Math.min(at, rest.length - 1)] ?? null) : selected,
  });
  deleteFiles([path]);
}

export function clearPlots() {
  const { plots } = usePlots.getState();
  usePlots.setState({ plots: [], selected: null });
  deleteFiles(plots);
}

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
  await call(commands.fsReadImage(path))
    .then((url) => writeDesktopBase64(to, url.slice(url.indexOf(",") + 1)))
    .catch(failed(tx("Cannot save the plot")));
}

export function copyPlot(path: string) {
  const png = call(commands.fsReadImage(path))
    .then((url) => fetch(url))
    .then((r) => r.blob());
  void writeClipboardPng(png).catch(failed(tx("Cannot copy the plot")));
}
