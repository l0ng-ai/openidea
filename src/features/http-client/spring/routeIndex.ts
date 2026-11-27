/** Spring request-path index, cached per project until a mapping source changes. */
import { call, commands, onIdeEvent, type ProjectInfo } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { projectFolder, relativePath, useProject } from "@/platform/project";
import { registerEndpointProvider, type EndpointEntry } from "@/workbench/contributions";
import { constantPool, resetConstantPool } from "./constants";
import { controllersOf } from "./endpoints";
import { controllerMethods, feignMethods, type HttpShape } from "./feign";
import { parseSource } from "./source";

interface ControllerTarget extends HttpShape {
  path: string;
}
interface ClientSource extends ControllerTarget {
  service: string | null;
}
interface RouteIndex {
  routes: EndpointEntry[];
  controllers: ControllerTarget[];
  clients: ClientSource[];
}

export function registerSpringEndpointProvider(): () => void {
  clearRouteIndex();
  const unregister = registerEndpointProvider({ id: "http.spring", endpoints: routeIndex });
  const unsubscribe = onIdeEvent("fsChanged", (e) => {
    if ([...e.created, ...e.modified, ...e.removed].some((p) => isRouteSource(String(p)))) clearRouteIndex();
  });
  return () => {
    unsubscribe();
    unregister();
    clearRouteIndex();
  };
}

let cached: { key: string; promise: Promise<RouteIndex> } | null = null;

/** Whether `path` is a source a mapping can live in (a Java or Kotlin file). */
export function isRouteSource(path: string): boolean {
  return /\.(java|kt|kts)$/i.test(path);
}

/** Forgets the index, so the next search rescans the project. */
export function clearRouteIndex() {
  cached = null;
  resetConstantPool();
}

/** The project's routes, scanned once per project and kept in memory. */
export function routeIndex(root: string | null): Promise<EndpointEntry[]> {
  return index(root).then((result) => result.routes);
}

export function controllerIndex(root: string | null): Promise<ControllerTarget[]> {
  return index(root).then((result) => result.controllers);
}

export function feignClientIndex(root: string): Promise<ClientSource[]> {
  return index(root).then((result) => result.clients);
}

function index(root: string | null): Promise<RouteIndex> {
  if (!root) return Promise.resolve({ routes: [], controllers: [], clients: [] });
  const current = useProject.getState().project;
  const project = current?.root === root ? current : null;
  const key = JSON.stringify([root, project?.workspace?.projects ?? null]);
  if (cached?.key === key) return cached.promise;
  const promise = scan(root, project).catch((error: unknown) => {
    if (cached?.promise === promise) cached = null;
    throw error;
  });
  cached = { key, promise };
  return promise;
}

async function scan(root: string, project: ProjectInfo | null): Promise<RouteIndex> {
  const sources = await call(commands.springRouteSources());
  const clients: ClientSource[] = [];
  const routes: EndpointEntry[] = [];
  const controllers: ControllerTarget[] = [];
  const parsed = [];
  for (const source of sources) {
    const path = ipcPath(source.path);
    const folder = project ? projectFolder(project, path)?.root : root;
    if (!folder) continue;
    const base = ipcPath(folder).replace(/\/$/, "");
    if (!isSameOrInside(path, base)) continue;
    for (const { paths, methods, service } of feignMethods(source.text))
      clients.push({ path, paths, methods, service });
    if (!source.text.includes("Controller")) continue;
    parsed.push({ source, path, base, file: parseSource(source.text) });
  }
  // Mapping paths built from other classes' constants need those classes first.
  const pool = constantPool();
  await pool.load(parsed.map((p) => p.file));
  for (const { source, path, base, file } of parsed) {
    controllers.push(...controllerMethods(source.text, file).map((method) => ({ ...method, path })));
    for (const controller of controllersOf(file, pool.resolverFor(file))) {
      for (const endpoint of controller.endpoints) {
        const at = lineCol(source.text, endpoint.offset);
        // A mapping without a path answers nothing to look up by URL; the method
        // itself is still reachable through the symbol index.
        for (const url of endpoint.paths) {
          routes.push({
            method: endpoint.httpMethod,
            url,
            controller: controller.name,
            methodName: endpoint.methodName,
            path,
            rel: relativePath(base, path),
            line: at.line,
            col: at.col,
          });
        }
      }
    }
  }
  return { routes, controllers, clients };
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}
