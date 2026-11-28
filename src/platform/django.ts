/** Django projects: the `manage.py` a file belongs to. */
import { call, commands } from "./ipc";

const INSTALLED = /\/(?:site-packages|node_modules|\.venv|venv)\//;
const depth = (path: string) => path.split("/").length;

/**
 * The `manage.py` for `near` (a file or folder): the deepest one whose folder contains it, else
 * the project's shallowest. Copies inside installed packages and virtualenvs don't count.
 */
export function pickManage(paths: readonly string[], near?: string | null): string | null {
  const own = paths.filter((p) => !INSTALLED.test(p));
  const containing = near ? own.filter((p) => near.startsWith(p.slice(0, p.lastIndexOf("/") + 1))) : [];
  const sorted = containing.length
    ? containing.sort((a, b) => depth(b) - depth(a))
    : own.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return sorted[0] ?? null;
}

/** Looks the project's `manage.py` files up in the index (none while it is still building). */
export async function findManage(near?: string | null): Promise<string | null> {
  return pickManage((await call(commands.findFilesNamed("manage.py"))).map(String), near);
}
