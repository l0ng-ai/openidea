/** What the Python Packages tool window lists, and the requirement an operation installs. */
import type { PypiPackage, PythonPackage } from "@/platform/ipc";

/** How pip and PyPI compare names (PEP 503). */
export const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Whether `text` can be a distribution name, so it is worth asking PyPI for. */
export const isPackageName = (text: string) =>
  text.length <= 128 && /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(text);

export type Row =
  | { kind: "section"; id: "installed" | "pypi" }
  | { kind: "installed"; name: string; version: string; latest: string | null }
  | { kind: "pypi"; name: string; latest: string };

export const rowKey = (row: Row) => (row.kind === "section" ? `section:${row.id}` : `${row.kind}:${row.name}`);

/**
 * The installed packages matching `query`, then the PyPI project the query names when it
 * is not installed. `newer` maps a package to its newer release.
 */
export function listRows(
  installed: readonly PythonPackage[],
  newer: ReadonlyMap<string, string> | null,
  found: PypiPackage | null,
  query: string,
): Row[] {
  // `typing-extensions` finds `typing_extensions`, as pip would.
  const q = normalize(query.trim());
  const rows: Row[] = [];
  for (const p of installed) {
    if (q && !normalize(p.name).includes(q)) continue;
    const latest = newer?.get(p.name);
    rows.push({
      kind: "installed",
      name: p.name,
      version: p.version,
      latest: latest && latest !== p.version ? latest : null,
    });
  }
  if (rows.length) rows.unshift({ kind: "section", id: "installed" });
  if (found && !installed.some((p) => normalize(p.name) === normalize(found.name))) {
    rows.push({ kind: "section", id: "pypi" }, { kind: "pypi", name: found.name, latest: found.latest });
  }
  return rows;
}

/** `name==version`, or the bare name for the newest release. */
export const requirementOf = (name: string, version: string | null) => (version ? `${name}==${version}` : name);
