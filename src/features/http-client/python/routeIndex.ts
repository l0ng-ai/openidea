/** Flask / FastAPI request-path index, cached per project until a Python file changes. */
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { projectFolder, relativePath, useProject } from "@/platform/project";
import { endpointsChanged, registerEndpointProvider, type EndpointEntry } from "@/workbench/contributions";
import { pythonRoutes, type PythonSource } from "./routes";

export const PYTHON_ENDPOINTS = "http.python";

let cached: { root: string; promise: Promise<EndpointEntry[]> } | null = null;

export function registerPythonEndpointProvider(): () => void {
  cached = null;
  const unregister = registerEndpointProvider({ id: PYTHON_ENDPOINTS, endpoints: pythonRouteIndex });
  const unsubscribe = onIdeEvent("fsChanged", (e) => {
    if (![...e.created, ...e.modified, ...e.removed].some((p) => String(p).endsWith(".py"))) return;
    cached = null;
    endpointsChanged();
  });
  return () => {
    unsubscribe();
    unregister();
    cached = null;
  };
}

export function pythonRouteIndex(root: string): Promise<EndpointEntry[]> {
  if (cached?.root === root) return cached.promise;
  const promise = scan(root).catch((error: unknown) => {
    if (cached?.promise === promise) cached = null;
    throw error;
  });
  cached = { root, promise };
  return promise;
}

async function scan(root: string): Promise<EndpointEntry[]> {
  const current = useProject.getState().project;
  const project = current?.root === root ? current : null;
  const sources: PythonSource[] = [];
  for (const source of await call(commands.pythonRouteSources())) {
    const path = ipcPath(source.path);
    const folder = project ? projectFolder(project, path)?.root : root;
    if (!folder) continue;
    const base = ipcPath(folder).replace(/\/$/, "");
    if (!isSameOrInside(path, base)) continue;
    sources.push({ path, rel: relativePath(base, path), text: source.text });
  }
  return pythonRoutes(sources).map((r) => ({
    method: r.method,
    url: r.url,
    framework: r.framework,
    controller: r.module,
    methodName: r.handler,
    path: r.path,
    rel: r.rel,
    line: r.line,
    col: r.col,
  }));
}
