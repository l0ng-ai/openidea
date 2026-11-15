import { isTauri } from "@/platform/ipc";

/** File / folder chooser (Tauri dialog); null when cancelled or outside Tauri. */
export async function choosePath(opts: {
  directory: boolean;
  title: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (!isTauri()) return null;
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
