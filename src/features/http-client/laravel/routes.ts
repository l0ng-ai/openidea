/**
 * Laravel routes in the editor and in Search Everywhere. The native PHP
 * engine computes everything (the route table, the code lens on controller
 * methods, the URI hint after each registration, the URL from `APP_URL`, the
 * request text); this side offers the actions on a clicked lens or hint —
 * go to the declaration, copy the URL, open it in the browser, create an
 * HTTP client request — and feeds the routes to the Routes scope.
 */
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, type LaravelRoute } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { ipcPath } from "@/platform/paths";
import { registerClientCommand } from "@/editor/lsp/clientCommands";
import { copyText, showContextMenu, type MenuItem } from "@/ui";
import { editorService, notifications, registerEndpointProvider, type EndpointEntry } from "@/workbench/contributions";
import { appendToGeneratedRequests } from "../spring/editor";

/** The command of the engine's route lenses and hints (`ide_php` `ROUTE_ACTIONS_COMMAND`). */
export const ROUTE_ACTIONS_COMMAND = "laravel.routeActions";

/** The routes a lens or hint command carries: one argument, their JSON. */
export function routesOf(args: readonly unknown[]): LaravelRoute[] {
  const [arg] = args;
  let value: unknown = arg;
  if (typeof arg === "string") {
    try {
      value = JSON.parse(arg);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((r): r is LaravelRoute => !!r && typeof r === "object" && typeof (r as LaravelRoute).uri === "string")
    .map((r) => ({ ...r, path: ipcPath(String(r.path)) }));
}

/** `GET /posts/{post}`. */
const routeLabel = (r: LaravelRoute) => `${r.methods.join("|")} ${r.uri}`;

export interface RouteActions {
  goto(r: LaravelRoute): void;
  copyUrl(r: LaravelRoute): void;
  open(r: LaravelRoute): void;
  createRequest(r: LaravelRoute): void;
}

const actions: RouteActions = {
  goto: (r) =>
    void editorService().openFile(r.path, {
      selection: { line: r.range.start.line, col: r.range.start.col },
      focus: true,
    }),
  copyUrl: (r) =>
    void copyText(r.url).then(() =>
      notifications().notify({ level: "info", title: tx`Copied ${r.url}`, key: "laravel-route-url" }),
    ),
  open: (r) => void openExternalUrl(r.url),
  createRequest: (r) =>
    void appendToGeneratedRequests([r.request]).catch((err: unknown) =>
      notifications().notify({
        level: "error",
        title: "Cannot create the HTTP request",
        body: err instanceof Error ? err.message : String(err),
        key: "laravel-route-request",
      }),
    ),
};

/** The actions of one route. */
function routeItems(r: LaravelRoute, run: RouteActions): MenuItem[] {
  return [
    { label: "Go to Declaration", run: () => run.goto(r) },
    { label: "Copy URL", icon: "copy", run: () => run.copyUrl(r) },
    { label: "Open in Browser", icon: "external-link", run: () => run.open(r) },
    { label: "Create HTTP Request", icon: "file-http", run: () => run.createRequest(r) },
  ];
}

/** The menu of a lens or hint: the actions of its route, or a submenu per route. */
export function routeMenuItems(routes: readonly LaravelRoute[], run: RouteActions = actions): MenuItem[] {
  if (routes.length === 1) return routeItems(routes[0]!, run);
  return routes.map((r) => ({
    label: r.name ? `${routeLabel(r)} · ${r.name}` : routeLabel(r),
    verbatim: true,
    submenu: routeItems(r, run),
  }));
}

/** The routes as Search Everywhere endpoints (`PostController.show`, or the action text). */
export function endpointEntries(routes: readonly LaravelRoute[], root: string): EndpointEntry[] {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return routes.map((r) => {
    const at = r.action.lastIndexOf("@");
    const cls = at >= 0 ? r.action.slice(0, at) : r.action;
    const controller = cls.slice(cls.lastIndexOf("\\") + 1);
    const methodName = at >= 0 ? r.action.slice(at + 1) : "";
    const action = methodName ? `${controller}@${methodName}` : r.action;
    return {
      method: r.methods.join("|"),
      url: r.uri,
      controller,
      methodName,
      path: r.path,
      rel: r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path,
      line: r.range.start.line,
      col: r.range.start.col,
      name: r.name ?? undefined,
      detail: [r.name, action].filter(Boolean).join(" · "),
    };
  });
}

async function laravelEndpoints(root: string): Promise<EndpointEntry[]> {
  if (!isTauri()) return [];
  const routes = await call(commands.phpLaravelRoutes("")).catch((): LaravelRoute[] => []);
  return endpointEntries(
    routes.map((r) => ({ ...r, path: ipcPath(String(r.path)) })),
    root,
  );
}

export function registerLaravelRoutes(): () => void {
  const disposers = [
    registerClientCommand(ROUTE_ACTIONS_COMMAND, (args, { view, event }) => {
      const routes = routesOf(args);
      if (!routes.length) return;
      const at = event
        ? { x: event.clientX, y: event.clientY }
        : (() => {
            const rect = view.coordsAtPos(view.state.selection.main.head);
            return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 };
          })();
      showContextMenu(at, routeMenuItems(routes));
    }),
    registerEndpointProvider({ id: "http.laravel", endpoints: laravelEndpoints }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
