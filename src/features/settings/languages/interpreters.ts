/**
 * The IDE-wide Python interpreter list (Settings › Python › All Interpreters): detection,
 * the interpreters other recent projects use, and the ones the user added — minus
 * the ones they removed. Selectors (the interpreter combo, the status bar popup)
 * read the same list so an added or removed interpreter shows up everywhere.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { basename, useProject } from "@/platform/project";
import type { IconName } from "@/ui/icons";
import { useStagedValue } from "../components/context";
import {
  detectSdks,
  pythonInterpreter,
  pythonProjectInterpreters,
  useSdks,
  type ProjectInterpreter,
  type Sdk,
} from "./api";

/** A project the interpreter list knows: its folder and the name shown for it. */
export interface NamedProject {
  root: string;
  name: string;
}

export interface InterpreterRow {
  path: string;
  name: string;
  version: string | null;
  source: string;
  home: string | null;
  /** Root of the project the interpreter belongs to (a virtualenv inside it), if known. */
  project: string | null;
  /** Added to the list by the user (persisted in the global settings). */
  added: boolean;
  /** The executable cannot run any more. */
  invalid: boolean;
}

/** `/`-separated path without a trailing separator. */
export function normalizeInterpreterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Windows paths (`C:\…`, `\\server\…`) are case-insensitive; a POSIX path is not. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//");
}

/** What path comparisons use: separators unified, and case folded only where the filesystem does. */
export function interpreterPathKey(path: string): string {
  const normalized = normalizeInterpreterPath(path);
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/** The icon for an interpreter's source: virtualenv / conda / uv / Poetry, version managers, system. */
export function interpreterIcon(source: string): IconName {
  switch (source) {
    case "conda":
      return "python-conda";
    case "uv":
      return "python-uv";
    case "poetry":
      return "python-poetry";
    case "pyenv":
    case "mise":
    case "asdf":
      return "python-versions";
    case "venv":
    case "pixi":
      return "python-venv";
    default:
      // System / PATH interpreters (and a chosen executable detection cannot classify).
      return "project-python";
  }
}

/** The longest project root containing `path` (`null` outside every project). */
export function owningProject(path: string, projects: readonly NamedProject[]): string | null {
  const p = interpreterPathKey(path);
  let best: NamedProject | null = null;
  for (const project of projects) {
    const root = interpreterPathKey(project.root);
    if (!root || (p !== root && !p.startsWith(`${root}/`))) continue;
    if (!best || root.length > interpreterPathKey(best.root).length) best = project;
  }
  return best ? normalizeInterpreterPath(best.root) : null;
}

/** The name shown for a project root, falling back to its folder name. */
export function projectName(root: string, projects: readonly NamedProject[]): string {
  return (
    projects.find((project) => interpreterPathKey(project.root) === interpreterPathKey(root))?.name ?? basename(root)
  );
}

/** Whether two interpreter paths name the same interpreter (a relative setting is resolved against `root`). */
export function sameInterpreterPath(a: string, b: string, root: string | null): boolean {
  if (!a || !b) return false;
  const absolute = (path: string) =>
    root && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("/") && !path.startsWith("~") ? `${root}/${path}` : path;
  const resolved = (path: string) => interpreterPathKey(absolute(path));
  if (resolved(a) === resolved(b)) return true;
  // The backend expands `~`; the frontend knows no home directory, so a `~/…` setting is
  // matched by the tail of the absolute path (`~/.pyenv/…` → `/.pyenv/…`).
  const tail = (path: string) => (path.startsWith("~/") ? interpreterPathKey(path).slice(1) : null);
  const [ta, tb] = [tail(a), tail(b)];
  if (ta && tb) return ta === tb;
  if (ta) return resolved(b).endsWith(ta);
  if (tb) return resolved(a).endsWith(tb);
  return false;
}

export interface BuildInterpreters {
  detected: readonly Sdk[];
  /** Interpreters other projects use, with their roots. */
  fromProjects: readonly ProjectInterpreter[];
  /** Interpreters the user added, resolved when possible. */
  added: readonly Sdk[];
  /** Added paths that no longer run. */
  missing: readonly string[];
  /** Paths the user removed from the list. */
  hidden: readonly string[];
  /** The open project's configured interpreter. */
  current: string | null;
  /** The open project. */
  currentProject: string | null;
  /** Projects an interpreter's path can belong to. */
  projects: readonly NamedProject[];
}

/** One row per interpreter, the current project's interpreter always present. */
export function buildInterpreters({
  detected,
  fromProjects,
  added,
  missing,
  hidden,
  current,
  currentProject,
  projects,
}: BuildInterpreters): InterpreterRow[] {
  const rows = new Map<string, InterpreterRow>();
  const put = (sdk: Sdk, project: string | null, isAdded = false) => {
    const id = interpreterPathKey(sdk.path);
    const existing = rows.get(id);
    if (existing) {
      existing.project ??= project;
      existing.added ||= isAdded;
      return;
    }
    rows.set(id, {
      path: sdk.path,
      name: sdk.name || sdk.path,
      version: sdk.version ?? null,
      source: sdk.source,
      home: sdk.home ?? null,
      project: project ?? owningProject(sdk.home ?? sdk.path, projects),
      added: isAdded,
      invalid: false,
    });
  };
  for (const sdk of detected) put(sdk, null);
  for (const entry of fromProjects) put(entry.sdk, entry.project);
  for (const sdk of added) put(sdk, null, true);
  for (const path of missing) {
    if (rows.has(interpreterPathKey(path))) continue;
    rows.set(interpreterPathKey(path), {
      path,
      name: path,
      version: null,
      source: "custom",
      home: null,
      project: owningProject(path, projects) ?? currentProject,
      added: true,
      invalid: true,
    });
  }
  const hiddenIds = new Set(hidden.map(interpreterPathKey));
  // The interpreter the project is set to stays visible even if it was removed from the
  // list: hiding it would leave the project pointing at nothing the user can see.
  const out = [...rows.values()].filter(
    (row) =>
      !hiddenIds.has(interpreterPathKey(row.path)) ||
      (!!current && interpreterPathKey(row.path) === interpreterPathKey(current)),
  );
  // A configured interpreter detection no longer finds (its file is gone) stays listed.
  if (current && !out.some((row) => interpreterPathKey(row.path) === interpreterPathKey(current))) {
    out.push({
      path: current,
      name: current,
      version: null,
      source: "custom",
      home: null,
      project: currentProject,
      added: false,
      invalid: true,
    });
  }
  const compare = (a: InterpreterRow, b: InterpreterRow) =>
    Number(a.invalid) - Number(b.invalid) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  return out.sort(compare);
}

/** PyCharm's "venv", "venv (2)": a suffix tells apart interpreters that share a name. */
export function uniqueNames(rows: readonly InterpreterRow[]): InterpreterRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.name, (totals.get(row.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if ((totals.get(row.name) ?? 0) < 2) return row;
    const n = (seen.get(row.name) ?? 0) + 1;
    seen.set(row.name, n);
    return n === 1 ? row : { ...row, name: `${row.name} (${n})` };
  });
}

export interface FilterInterpreters {
  query: string;
  /** Hide interpreters that belong to another project (the current one always stays). */
  hideOther: boolean;
  currentProject: string | null;
}

/** Rows matching the search and the "other projects" filter, in list order. */
export function filterInterpreters(rows: readonly InterpreterRow[], opts: FilterInterpreters): InterpreterRow[] {
  const terms = opts.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return rows.filter((row) => {
    if (
      opts.hideOther &&
      opts.currentProject &&
      row.project &&
      interpreterPathKey(row.project) !== interpreterPathKey(opts.currentProject)
    )
      return false;
    if (!terms.length) return true;
    const hay = `${row.name}\n${row.path}\n${row.source}\n${row.project ?? ""}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/** The merged interpreter list and the state the interpreters page shows. */
export interface PythonInterpreters extends BuildInterpreters {
  /** Rows with distinct names, hidden ones excluded. */
  rows: InterpreterRow[];
  loading: boolean;
  refresh: () => void;
}

const NO_PATHS: string[] = [];
const NO_SDKS: Sdk[] = [];

/**
 * The IDE-wide list for the current settings dialog. Reads the global list settings
 * (`languages.python.interpreters`…) and the open project's interpreter; adding and
 * removing happens on the interpreters page. `withProjects: false` skips looking up
 * the interpreters of other recent projects (selectors only need this machine's).
 */
export function usePythonInterpreters(opts: { withProjects?: boolean } = {}): PythonInterpreters {
  const withProjects = opts.withProjects !== false;
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? null);
  const added = (useStagedValue("global", "languages.python.interpreters") as string[] | undefined) ?? NO_PATHS;
  const hidden = (useStagedValue("global", "languages.python.hiddenInterpreters") as string[] | undefined) ?? NO_PATHS;
  const current = (useStagedValue("project", "languages.python.interpreter") as string | undefined) || null;
  const detectedState = useSdks((s) => s.byKind.python);
  const detected = detectedState ?? NO_SDKS;
  const loading = useSdks((s) => !!s.loading.python || !s.byKind.python);
  const [fromProjects, setFromProjects] = useState<ProjectInterpreter[]>([]);
  const [probed, setProbed] = useState<ReadonlyMap<string, Sdk | null>>(new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void detectSdks("python");
  }, []);
  useEffect(() => {
    if (!withProjects) return;
    let live = true;
    pythonProjectInterpreters()
      .then((list) => live && setFromProjects(list))
      .catch(() => live && setFromProjects([]));
    return () => {
      live = false;
    };
  }, [tick, withProjects]);

  useEffect(() => {
    if (!added.length) return;
    let live = true;
    const known = new Set([
      ...detected.map((sdk) => interpreterPathKey(sdk.path)),
      ...fromProjects.map((entry) => interpreterPathKey(entry.sdk.path)),
    ]);
    const todo = added.filter((path) => !known.has(interpreterPathKey(path)) && !probed.has(path));
    if (!todo.length) return;
    void Promise.all(
      todo.map(async (path) => {
        try {
          return [path, await pythonInterpreter(path)] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setProbed((currentMap) => {
        const next = new Map(currentMap);
        for (const [path, sdk] of pairs) next.set(path, sdk);
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [added, detected, fromProjects, probed]);

  const projects = useMemo<NamedProject[]>(() => {
    const list: NamedProject[] = root ? [{ root, name: name || basename(root) }] : [];
    for (const entry of fromProjects) {
      if (!list.some((project) => interpreterPathKey(project.root) === interpreterPathKey(entry.project)))
        list.push({ root: entry.project, name: basename(entry.project) });
    }
    return list;
  }, [root, name, fromProjects]);

  const addedSdks = useMemo(
    () =>
      added.map(
        (path): Sdk =>
          probed.get(path) ?? { path, name: path, version: null, source: "custom", home: null, extra: null },
      ),
    [added, probed],
  );
  const missing = useMemo(() => added.filter((path) => probed.get(path) === null), [added, probed]);
  const rows = useMemo(
    () =>
      uniqueNames(
        buildInterpreters({
          detected,
          fromProjects,
          added: addedSdks,
          missing,
          hidden,
          current,
          currentProject: root,
          projects,
        }),
      ),
    [detected, fromProjects, addedSdks, missing, hidden, current, root, projects],
  );
  const refresh = useCallback(() => {
    setProbed(new Map());
    setTick((t) => t + 1);
    void detectSdks("python", true);
  }, []);
  return {
    rows,
    loading,
    refresh,
    detected,
    fromProjects,
    added: addedSdks,
    missing,
    hidden,
    current,
    currentProject: root,
    projects,
  };
}
