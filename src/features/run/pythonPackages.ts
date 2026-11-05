/**
 * Which directories are Python packages (`__init__.py`), for running a module with relative
 * imports as `python -m package.module`. Read once per directory.
 */
import { call, commands, isTauri } from "@/platform/ipc";

const known = new Map<string, boolean>();

export function invalidatePythonPackages() {
  known.clear();
}

/** Whether `dir` is a package, when already read. */
export function isPythonPackage(dir: string): boolean | undefined {
  return known.get(dir);
}

const parent = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : "");

/** Reads the packages enclosing `path`'s directory, up to the first directory that isn't one. */
export async function loadPythonPackages(path: string): Promise<void> {
  if (!isTauri()) return;
  for (let dir = parent(parent(path)); dir; dir = parent(dir)) {
    if (!known.has(dir)) {
      const kind = await call(commands.fsEntryKind(`${dir}/__init__.py`)).catch(() => null);
      known.set(dir, kind === "file");
    }
    if (!known.get(dir) || dir === "/") return;
  }
}
