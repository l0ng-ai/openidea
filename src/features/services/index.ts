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
import { executeAction, registerActions } from "@/platform/actions";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import {
  SERVICES_WINDOW,
  registerEditorBanner,
  registerEditorKind,
  registerOverlay,
  registerServiceProvider,
  registerServiceView,
  registerToolWindow,
  showServiceView,
} from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { addFileIconProvider } from "@/ui";
import {
  activateComposeFiles,
  composeAutoDetectBanner,
  composeFileIcon,
  composeTargetAtLine,
  isComposeFile,
  setComposeFileOverride,
} from "./compose";
import { composeEditorExtension } from "./composeEditor";
import { dockerGutter } from "./dockerGutter";
import { gutterActions, registerDockerRunTypes } from "./runTypes";
import { ServicesDialogHost } from "./dialogs";
import { dockerProvider, selectedTarget } from "./docker";
import { DOCKER_LOG_EDITOR_KIND, DockerLogEditor, dockerLogEditorTitle, openContainerLogInEditor } from "./logEditor";
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
import { connections, refresh, setDockerFilters, useServices } from "./store";
import { SERVICES_TREE_VIEW } from "./tree";
import { isRunning } from "./model";
import type { PruneTarget } from "@/platform/ipc";

const PROJECT = "projectOpen";

/** The connection of the selection, else the first one. */
const currentConnection = () => selectedTarget()?.conn ?? connections()[0]?.id ?? null;

export function activate(): () => void {
  const disposers = [
    activateComposeFiles(),
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
    registerEditorKind({
      kind: DOCKER_LOG_EDITOR_KIND,
      component: DockerLogEditor,
      title: dockerLogEditorTitle,
      icon: () => "file-log",
      keepAlive: true,
    }),
    registerOverlay({ id: "services.dialogs", component: ServicesDialogHost }),
    addFileIconProvider(composeFileIcon),
    registerEditorBanner(composeAutoDetectBanner),
    registerEditorContribution({ id: "services.dockerGutter", order: 56, extensions: dockerGutter }),
    registerEditorContribution({ id: "services.composeEditor", order: 57, extensions: composeEditorExtension }),
    registerDockerRunTypes(),
    registerActions([
      {
        id: "docker.setComposeFileOverride",
        title: "Set Docker Compose File Detection",
        category: "Docker",
        hidden: true,
        run: ({ arg }) => {
          const { path, status } = (arg ?? {}) as { path?: string; status?: string };
          if (path && (status === "kept" || status === "excluded")) return setComposeFileOverride(path, status);
        },
      },
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
        id: "docker.showDashboard",
        title: "Show Docker Dashboard",
        category: "Docker",
        icon: "layout",
        when: PROJECT,
        run: () => {
          showDetail("dashboard");
          showServiceView(SERVICES_TREE_VIEW, true);
        },
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
        id: "docker.openLogInEditor",
        title: "Open Container Log in Editor",
        category: "Docker",
        icon: "file-log",
        when: PROJECT,
        run: () => {
          const t = selectedTarget();
          if (t?.node.kind === "container") openContainerLogInEditor(t.conn, t.node.container);
        },
      },
      {
        id: "docker.showProcesses",
        title: "Show Container Processes",
        category: "Docker",
        icon: "list",
        when: PROJECT,
        run: () => {
          showDetail("processes");
          showServiceView(SERVICES_TREE_VIEW, true);
        },
      },
      {
        id: "docker.showLayers",
        title: "Show Image Layers",
        category: "Docker",
        icon: "list",
        when: PROJECT,
        run: () => {
          showDetail("layers");
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
        id: "docker.toggleStoppedContainers",
        title: "Toggle Stopped Containers",
        category: "Docker",
        icon: "filter",
        when: PROJECT,
        run: () => setDockerFilters({ showStoppedContainers: !useServices.getState().filters.showStoppedContainers }),
      },
      {
        id: "docker.toggleUntaggedImages",
        title: "Toggle Untagged Images",
        category: "Docker",
        icon: "filter",
        when: PROJECT,
        run: () => setDockerFilters({ showUntaggedImages: !useServices.getState().filters.showUntaggedImages }),
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
        icon: "docker-pull",
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
      {
        id: "docker.composeUp",
        title: "Compose Up",
        description: "Start the service at the caret, or all services in the active Docker Compose file",
        category: "Docker",
        icon: "run",
        keywords: ["docker compose up", "start stack", "start service"],
        when: PROJECT,
        run: () => {
          const ed = activeEditor();
          if (!ed) return;
          const text = ed.view.state.doc.toString();
          if (!isComposeFile(ed.ctx.path, text)) return;
          const line = ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number - 1;
          const target = composeTargetAtLine(text, line) ?? { kind: "composeAll" as const, line: 0 };
          const root = useProject.getState().project?.root ?? null;
          const [action] = gutterActions(target, ed.ctx.path, root);
          if (action) void executeAction("run.runConfig", { config: action.config, temporary: true });
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
