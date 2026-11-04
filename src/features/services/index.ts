/**
 * Services tool window (⌘8): a tree of the services providers contribute
 * (IDEA's Services view), with "Add Service" (+, ⌘N). Docker is one provider:
 * connections (local socket, TCP / SSH host with TLS, a docker context) with
 * containers grouped by Compose project, images, volumes and networks, kept live
 * by `docker events`; lifecycle, logs, inspect, a shell in a terminal tab, pull
 * (logging in to saved registries) and prune. Dockerfile, Docker Image and Docker
 * Compose run configuration types; Dockerfiles and Compose files get gutter run
 * icons that start them.
 */
import { registerActions } from "@/platform/actions";
import { registerEditorContribution } from "@/editor/api";
import {
  SERVICES_WINDOW,
  registerOverlay,
  registerServiceProvider,
  registerServiceView,
  registerToolWindow,
  showServiceView,
} from "@/workbench/contributions";
import { dockerGutter } from "./dockerGutter";
import { registerDockerRunTypes } from "./runTypes";
import { ServicesDialogHost } from "./dialogs";
import { dockerProvider, selectedTarget } from "./docker";
import {
  canRemove,
  canStart,
  canStop,
  execShell,
  pullPrompt,
  prunePrompt,
  remove,
  restart,
  showDetail,
  start,
  stop,
} from "./ops";
import { SERVICES_VIEW_FOCUS, ServicesTreeView, showAddServiceMenu } from "./ServicesTree";
import { ServicesHeaderActions, ServicesHost, ServicesTabs } from "./ServicesHost";
import { connections, refresh } from "./store";
import { SERVICES_TREE_VIEW } from "./tree";
import { isRunning } from "./model";
import type { PruneTarget } from "@/platform/ipc";

const PROJECT = "projectOpen";

/** The connection of the selection, else the first one. */
const currentConnection = () => selectedTarget()?.conn ?? connections()[0]?.id ?? null;

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: SERVICES_WINDOW,
      title: "Services",
      icon: "toolwindow-services",
      anchor: "bottom",
      order: 8,
      stripe: "onUse",
      component: ServicesHost,
      headerContent: ServicesTabs,
      headerActions: ServicesHeaderActions,
    }),
    registerServiceView({
      id: SERVICES_TREE_VIEW,
      title: "Services",
      icon: "toolwindow-services",
      order: 0,
      component: ServicesTreeView,
    }),
    registerServiceProvider(dockerProvider),
    registerOverlay({ id: "services.dialogs", component: ServicesDialogHost }),
    registerEditorContribution({ id: "services.dockerGutter", order: 56, extensions: dockerGutter }),
    registerDockerRunTypes(),
    registerActions([
      {
        id: "services.show",
        title: "Services",
        category: "Docker",
        icon: "toolwindow-services",
        when: PROJECT,
        hidden: true,
        run: () => showServiceView(SERVICES_TREE_VIEW, true),
      },
      {
        id: "services.addService",
        title: "Add Service",
        description: "Add a run configuration type, Docker connection or registry to the Services tool window",
        category: "Services",
        icon: "plus",
        when: PROJECT,
        keyWhen: SERVICES_VIEW_FOCUS,
        keywords: ["docker connection", "docker registry", "run configuration type"],
        run: () => {
          showServiceView(SERVICES_TREE_VIEW, true);
          requestAnimationFrame(() => showAddServiceMenu());
        },
      },
      {
        id: "docker.refresh",
        title: "Refresh Docker",
        category: "Docker",
        icon: "refresh",
        when: PROJECT,
        run: () => refresh(),
      },
      {
        id: "docker.start",
        title: "Start Container",
        category: "Docker",
        icon: "run",
        when: PROJECT,
        run: () => (canStart(selectedTarget()) ? start(selectedTarget()) : undefined),
      },
      {
        id: "docker.stop",
        title: "Stop Container",
        category: "Docker",
        icon: "stop",
        when: PROJECT,
        run: () => (canStop(selectedTarget()) ? stop(selectedTarget()) : undefined),
      },
      {
        id: "docker.restart",
        title: "Restart Container",
        category: "Docker",
        icon: "rerun",
        when: PROJECT,
        run: () => restart(selectedTarget()),
      },
      {
        id: "docker.remove",
        title: "Delete Docker Object…",
        category: "Docker",
        icon: "trash",
        when: PROJECT,
        run: () => (canRemove(selectedTarget()) ? remove(selectedTarget()) : undefined),
      },
      {
        id: "docker.showLog",
        title: "Show Container Log",
        category: "Docker",
        when: PROJECT,
        run: () => {
          showDetail("log");
          showServiceView(SERVICES_TREE_VIEW, true);
        },
      },
      {
        id: "docker.inspect",
        title: "Inspect Docker Object",
        category: "Docker",
        icon: "info",
        when: PROJECT,
        run: () => {
          showDetail("inspect");
          showServiceView(SERVICES_TREE_VIEW, true);
        },
      },
      {
        id: "docker.execShell",
        title: "Create Terminal in Container",
        category: "Docker",
        icon: "terminal",
        keywords: ["exec", "shell", "attach"],
        when: PROJECT,
        run: () => {
          const t = selectedTarget();
          if (t?.node.kind === "container" && isRunning(t.node.container)) execShell(t);
        },
      },
      {
        id: "docker.pullImage",
        title: "Pull Docker Image…",
        category: "Docker",
        icon: "git-pull",
        when: PROJECT,
        run: () => {
          const conn = currentConnection();
          return conn ? pullPrompt(conn) : undefined;
        },
      },
      {
        id: "docker.prune",
        title: "Prune Docker…",
        description: "Argument: `containers`, `images`, `allImages`, `volumes`, `networks` or `system` (default).",
        category: "Docker",
        icon: "trash",
        keywords: ["clean", "system prune"],
        when: PROJECT,
        run: ({ arg }) => {
          const conn = currentConnection();
          return conn ? prunePrompt(conn, typeof arg === "string" ? (arg as PruneTarget) : "system") : undefined;
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
