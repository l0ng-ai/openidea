/**
 * Endpoints tool window (IntelliJ's Endpoints): the project's HTTP endpoints
 * as the registered providers report them. Providers come from plugins
 * (`[[contributes.endpoints]]`, e.g. `plugins/rails`) through
 * `pluginProviders.ts`, or from features through `registerEndpointProvider`.
 * The window is registered while some provider applies to the project; the
 * files that declare endpoints get a gutter icon (`gutter.ts`).
 */
import { registerEditorContribution } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { registerMenuGroup, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { ENDPOINTS_WINDOW, EndpointsHeaderActions, EndpointsView, useEndpointsHeaderMenu } from "./EndpointsView";
import {
  GENERATE_REQUEST,
  SHOW_IN_ENDPOINTS,
  endpointsAtCaret,
  endpointsEditorExtension,
  generateRequests,
  menuGroupItems,
  showInEndpoints,
} from "./gutter";
import { installPluginProviders } from "./pluginProviders";
import { refreshEndpoints, useEndpoints } from "./store";

export { ENDPOINTS_WINDOW };

/** Registers the tool window while a provider applies to the project. */
function installToolWindow(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (present: boolean) => {
    if (present && !dispose) {
      dispose = registerToolWindow({
        id: ENDPOINTS_WINDOW,
        title: "Endpoints",
        icon: "toolwindow-endpoints",
        anchor: "right",
        order: 45,
        component: EndpointsView,
        headerActions: EndpointsHeaderActions,
        headerMenu: useEndpointsHeaderMenu,
      });
    } else if (!present && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync(useEndpoints.getState().available);
  const unsubscribe = useEndpoints.subscribe((s) => sync(s.available));
  return () => {
    unsubscribe();
    dispose?.();
  };
}

export function activate(): () => void {
  const disposers = [
    installPluginProviders(),
    installToolWindow(),
    registerEditorContribution({ id: "endpoints.gutter", order: 58, extensions: endpointsEditorExtension }),
    registerMenuGroup({ id: "endpoints", menus: ["editor"], order: 41, items: (_menu, ctx) => menuGroupItems(ctx) }),
    registerActions([
      {
        id: "endpoints.show",
        title: "Endpoints",
        category: "Tools",
        icon: "toolwindow-endpoints",
        keywords: ["routes", "rest", "url", "api", "rails"],
        when: "projectOpen",
        run: () => {
          // The window exists only while a provider applies to the project.
          if (useEndpoints.getState().available) toolWindowService().show(ENDPOINTS_WINDOW, true);
        },
      },
      {
        id: "endpoints.refresh",
        title: "Refresh Endpoints",
        category: "Tools",
        icon: "refresh",
        when: "projectOpen",
        run: () => refreshEndpoints(),
      },
      {
        id: GENERATE_REQUEST,
        title: "Generate Request in HTTP Client",
        category: "Tools",
        icon: "file-http",
        keywords: ["endpoint", "route", "rest", "http client"],
        when: "projectOpen && textEditorActive",
        run: () => generateRequests(endpointsAtCaret()),
      },
      {
        id: SHOW_IN_ENDPOINTS,
        title: "Show in Endpoints",
        category: "Tools",
        icon: "toolwindow-endpoints",
        keywords: ["endpoint", "route"],
        when: "projectOpen && textEditorActive",
        run: () => {
          const e = endpointsAtCaret()[0];
          if (e) showInEndpoints(e);
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
