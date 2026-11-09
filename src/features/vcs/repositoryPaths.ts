/** Stored Git paths are relative to their repository, independently of the open project. */
import { ipcPath } from "@/platform/paths";

export function repositoryPath(root: string | null | undefined, path: string): string {
  if (!root) return path;
  const base = ipcPath(root).replace(/\/$/, "");
  // Backslashes are separators on Windows, but can be literal filename characters on POSIX.
  const relative = /^[A-Za-z]:\//.test(`${base}/`) || base.startsWith("//") ? path.replace(/\\/g, "/") : path;
  return `${base}/${relative}`;
}
