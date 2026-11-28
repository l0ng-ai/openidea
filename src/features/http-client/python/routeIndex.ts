/**
 * Flask / FastAPI request-path index: the project's sources scanned once, then kept up to date
 * file by file as `.py` files change.
 */
import { call, commands, onIdeEvent, type ProjectInfo } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { projectFolder, relativePath, useProject } from "@/platform/project";
import { endpointsChanged, registerEndpointProvider, type EndpointEntry } from "@/workbench/contributions";
import { missingModules, parsePython, routesOf, type PythonFile, type PythonRoute } from "./routes";

export const PYTHON_ENDPOINTS = "http.python";

/** More changed files than this at once (a branch switch) rescan the project instead. */
const MAX_FILE_UPDATES = 50;

interface Index {
  key: string;
  files: Promise<Map<string, PythonFile>>;
  routes: EndpointEntry[] | null;
  /** Paths tried for a module that a prefix names a value from, found or not. */
  tried: Set<string>;
}

let cached: Index | null = null;
/** Changed `.py` files not read again yet. */
let pending = new Set<string>();

export function registerPythonEndpointProvider(): () => void {
  reset();
  const unregister = registerEndpointProvider({ id: PYTHON_ENDPOINTS, endpoints: pythonRouteIndex });
  const unsubscribe = onIdeEvent("fsChanged", (e) => {
    const changed = [...e.created, ...e.modified, ...e.removed].map(String).filter((p) => p.endsWith(".py"));
    if (!changed.length) return;
    for (const path of changed) pending.add(ipcPath(path));
    if (pending.size > MAX_FILE_UPDATES) reset();
    else if (cached) cached.routes = null;
    endpointsChanged();
  });
  return () => {
    unsubscribe();
    unregister();
    reset();
  };
}

function reset() {
  cached = null;
  pending = new Set();
}

export async function pythonRouteIndex(root: string): Promise<EndpointEntry[]> {
  const index = current(root);
  if (index.routes && !pending.size) return index.routes;
  const files = await updated(index, root);
  if (cached !== index) return pythonRouteIndex(root);
  index.routes = routesOf([...files.values()]).map(entry);
  return index.routes;
}

/**
 * The routes of the file at `path` with `text` in place of what is on disk: the editor's
 * gutter while the file is being edited.
 */
export async function pythonEndpointsOf(root: string, path: string, text: string): Promise<EndpointEntry[]> {
  const files = new Map(await updated(current(root), root));
  const source = sourceAt(root, ipcPath(path), text);
  if (!source) return [];
  files.set(source.path, parsePython({ ...source, path }));
  return routesOf([...files.values()])
    .filter((r) => r.path === path)
    .map(entry);
}

function current(root: string): Index {
  const project = projectOf(root);
  const key = JSON.stringify([root, project?.workspace?.projects ?? null]);
  if (cached?.key !== key) {
    pending = new Set();
    const files = scan(root).catch((error: unknown) => {
      if (cached?.files === files) cached = null;
      throw error;
    });
    cached = { key, files, routes: null, tried: new Set() };
  }
  return cached;
}

const projectOf = (root: string): ProjectInfo | null => {
  const project = useProject.getState().project;
  return project?.root === root ? project : null;
};

/** The index's files, with the changed ones read again and the modules their prefixes name added. */
async function updated(index: Index, root: string): Promise<Map<string, PythonFile>> {
  const files = await index.files;
  if (cached !== index) return files;
  if (pending.size) {
    const paths = [...pending];
    pending = new Set();
    for (const path of paths) index.tried.delete(path);
    const texts = await Promise.all(paths.map(readText));
    paths.forEach((path, i) => {
      const text = texts[i];
      const source = text !== null && text !== undefined && mentionsFramework(text) ? sourceAt(root, path, text) : null;
      if (source) files.set(path, parsePython(source));
      else files.delete(path);
    });
  }
  await addNamedModules(index, files, root);
  return files;
}

const readText = (path: string) => call(commands.fsReadText(path)).catch(() => null);

/**
 * Reads the modules a prefix names a value from (a settings module), from the folders above the
 * file that imports them: `app.core.config` next to `app/main.py` is `app/core/config.py` there.
 */
async function addNamedModules(index: Index, files: Map<string, PythonFile>, root: string, hops = 2): Promise<void> {
  const wanted = missingModules([...files.values()]).flatMap(({ file, module }) => {
    const tail = module.replace(/\./g, "/");
    // The file's folder and each one above it, up to its project folder.
    const base = file.source.path.slice(0, file.source.path.length - file.source.rel.length).replace(/\/$/, "");
    const parts = file.source.rel.split("/").slice(0, -1);
    const dirs = parts.map((_, i) => [base, ...parts.slice(0, parts.length - i)].join("/")).concat(base);
    return dirs.flatMap((dir) => [`${dir}/${tail}.py`, `${dir}/${tail}/__init__.py`]);
  });
  const paths = [...new Set(wanted)].filter((path) => !index.tried.has(path) && !files.has(path));
  if (!paths.length) return;
  for (const path of paths) index.tried.add(path);
  const texts = await Promise.all(paths.map(readText));
  paths.forEach((path, i) => {
    const source = texts[i] ? sourceAt(root, path, texts[i]!) : null;
    if (source) files.set(path, parsePython(source));
  });
  // A module read now may name a value from one more (a settings module importing its defaults).
  if (hops > 1) await addNamedModules(index, files, root, hops - 1);
}

/** The backend's filter: a source that imports neither framework declares no route. */
const mentionsFramework = (text: string) => text.includes("flask") || text.includes("fastapi");

/** `path` as a source of the project folder it belongs to; null outside the project or in installed packages. */
function sourceAt(root: string, path: string, text: string) {
  if (path.includes("/site-packages/")) return null;
  const project = projectOf(root);
  const folder = project ? projectFolder(project, path)?.root : root;
  if (!folder) return null;
  const base = ipcPath(folder).replace(/\/$/, "");
  return isSameOrInside(path, base) ? { path, rel: relativePath(base, path), text } : null;
}

async function scan(root: string): Promise<Map<string, PythonFile>> {
  const files = new Map<string, PythonFile>();
  for (const source of await call(commands.pythonRouteSources())) {
    const path = ipcPath(source.path);
    const found = sourceAt(root, path, source.text);
    if (found) files.set(path, parsePython(found));
  }
  return files;
}

const entry = (r: PythonRoute): EndpointEntry => ({
  method: r.method,
  url: r.url,
  framework: r.framework,
  controller: r.module,
  methodName: r.handler,
  path: r.path,
  rel: r.rel,
  line: r.line,
  col: r.col,
});
