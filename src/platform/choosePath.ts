import { isTauri } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import type { DialogFilter, SaveDialogOptions } from "@/platform/dialog";

export interface ChoosePathOptions {
  directory: boolean;
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

export interface HostPathOptions extends ChoosePathOptions {
  multiple?: boolean;
  save?: boolean;
  signal?: AbortSignal;
}

type HostChooser = (opts: HostPathOptions) => Promise<string[] | null>;
let hostChooser: HostChooser | null = null;

/**
 * Registers the in-app chooser that browses the remote host (the workbench's, in `inputDialogs`):
 * the desktop's own dialog would show this machine's files.
 */
export function registerHostPathChooser(chooser: HostChooser): () => void {
  hostChooser = chooser;
  return () => {
    if (hostChooser === chooser) hostChooser = null;
  };
}

/**
 * File / folder chooser for a path on the host this window's commands run on: the desktop's dialog
 * locally, the in-app chooser in a remote window. Null when cancelled or outside Tauri.
 */
export async function choosePath(opts: ChoosePathOptions, signal?: AbortSignal): Promise<string | null> {
  if (!isTauri() || signal?.aborted) return null;
  if (isRemoteWindow()) return (await hostChooser?.({ ...opts, signal }))?.[0] ?? null;
  // Lazy on purpose: loading platform/dialog starts its GTK capability probe at module load.
  const { open } = await import("@/platform/dialog");
  if (signal?.aborted) return null;
  const picked = await open({ ...opts, multiple: false, defaultPath: opts.defaultPath || undefined });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

/** Pick multiple existing paths on the project host. */
export async function choosePaths(opts: ChoosePathOptions): Promise<string[]> {
  if (!isTauri()) return [];
  if (isRemoteWindow()) return (await hostChooser?.({ ...opts, multiple: true })) ?? [];
  const { open } = await import("@/platform/dialog");
  const picked = await open({ ...opts, multiple: true });
  return typeof picked === "string" ? [picked] : (picked ?? []);
}

/** Choose a destination on the project host and confirm replacement if it exists. */
export async function chooseSavePath(opts: SaveDialogOptions): Promise<string | null> {
  if (isRemoteWindow()) return (await hostChooser?.({ ...opts, directory: false, save: true }))?.[0] ?? null;
  const { save } = await import("@/platform/dialog");
  return save(opts);
}
