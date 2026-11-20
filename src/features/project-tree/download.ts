/** Download to… in a remote project: copies the selected remote files and folders to this machine. */
import { Channel } from "@tauri-apps/api/core";
import type { DownloadProgress } from "@/bindings";
import { open } from "@/platform/dialog";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { invokeLocal } from "@/platform/tauriCore";
import { notifications } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";
import { isInside, nameOf } from "./paths";

/** Whether this window's project files live on another machine, so they can be downloaded. */
export const canDownload = () => isRemoteWindow();

/** Asks for a local folder and downloads `paths` into it, each under its own name. */
export async function downloadTo(paths: readonly string[]) {
  // A selected folder brings its selected children along; downloading them again would duplicate them.
  const tops = paths.filter((p, i) => paths.indexOf(p) === i && !paths.some((q) => isInside(p, q)));
  if (!tops.length || !canDownload()) return;
  const folder = await open({ directory: true, multiple: false, title: tx("Download to") });
  if (typeof folder !== "string") return;
  const request = nextRequestId();
  const task = {
    id: `file-download-${request}`,
    title: tx("Downloading files"),
    message: null as string | null,
    fraction: null as number | null,
    cancel: () => void invokeLocal("cancel_request", { id: request }).catch(() => {}),
  };
  upsertTask({ ...task, done: false });
  const progress = new Channel<DownloadProgress>();
  progress.onmessage = (p) =>
    upsertTask({ ...task, message: nameOf(p.path), fraction: p.total ? p.done / p.total : null, done: false });
  try {
    const report = await call(commands.remoteDownloadLocal([...tops], folder, request, progress));
    const failed = report.errors.length > 0;
    notifications().notify({
      level: failed ? (report.files ? "warning" : "error") : "info",
      title: failed
        ? tx`Download to ${folder} finished with errors`
        : tx`Downloaded ${report.files} files to ${folder}`,
      body: failed ? report.errors.map((e) => `${e.path}: ${e.message}`).join("\n") : undefined,
      key: "project.download",
    });
  } catch (e) {
    if (isCancelled(e)) return;
    notifications().notify({
      level: "error",
      title: tx`Cannot download to ${folder}`,
      body: e instanceof Error ? e.message : String(e),
      key: "project.download",
    });
  } finally {
    upsertTask({ ...task, done: true });
  }
}
