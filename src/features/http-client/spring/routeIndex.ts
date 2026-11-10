/** Spring request-path index, cached per project until a mapping source changes. */
import { call, commands, onIdeEvent, type ProjectInfo } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { projectFolder, relativePath, useProject } from "@/platform/project";
import { registerEndpointProvider, type EndpointEntry } from "@/workbench/contributions";
import { springControllers } from "./endpoints";

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

let cached: { key: string; promise: Promise<EndpointEntry[]> } | null = null;

/** Whether `path` is a source a mapping can live in (a Java or Kotlin file). */
export function isRouteSource(path: string): boolean {
  return /\.(java|kt|kts)$/i.test(path);
}

/** Forgets the index, so the next search rescans the project. */
export function clearRouteIndex() {
  cached = null;
}

/** The project's routes, scanned once per project and kept in memory. */
export function routeIndex(root: string | null): Promise<EndpointEntry[]> {
  if (!root) return Promise.resolve([]);
  const current = useProject.getState().project;
  const project = current?.root === root ? current : null;
  const key = JSON.stringify([root, project?.workspace?.projects ?? null]);
  if (cached?.key === key) return cached.promise;
  const promise = scan(root, project);
  cached = { key, promise };
  return promise;
}

async function scan(root: string, project: ProjectInfo | null): Promise<EndpointEntry[]> {
  const sources = await call(commands.springRouteSources());
  const routes: EndpointEntry[] = [];
  for (const source of sources) {
    const path = ipcPath(source.path);
    const folder = project ? projectFolder(project, path)?.root : root;
    if (!folder) continue;
    const base = ipcPath(folder).replace(/\/$/, "");
    if (!isSameOrInside(path, base)) continue;
    for (const controller of springControllers(source.text)) {
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
  return routes;
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
