import { isTauri } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";

export interface ChoosePathOptions {
  directory: boolean;
  title: string;
  defaultPath?: string;
}

type HostChooser = (opts: ChoosePathOptions) => Promise<string | null>;
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
export async function choosePath(opts: ChoosePathOptions): Promise<string | null> {
  if (!isTauri()) return null;
  if (isRemoteWindow() && hostChooser) return hostChooser(opts);
  // Lazy on purpose: loading platform/dialog starts its GTK capability probe at module load.
  const { open } = await import("@/platform/dialog");
  const picked = await open({
    directory: opts.directory,
    multiple: false,
    title: opts.title,
    defaultPath: opts.defaultPath || undefined,
  });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}
