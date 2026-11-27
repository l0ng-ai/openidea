/**
 * Remote development: a window whose project lives on an SSH host, in a WSL distribution or in a
 * dev container. The backend (`openidea-server`) runs there and this window routes its commands
 * to it (platform/remote.ts).
 */
import { registerActions } from "@/platform/actions";
import { disconnectRemote, provideBackendBusyPrompt, stopRemoteBackend, useRemote } from "@/platform/remote";
import { lazyComponent } from "@/ui";
import { maybeEditorService, registerOverlay, registerStatusItem, registerToolWindow } from "@/workbench/contributions";
import { isStatusItemVisible, setStatusWidgetAvailable, setStatusWidgetVisible } from "@/workbench/statusBarWidgets";
import { confirm } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { ConnectHost } from "./ConnectDialog";
import { installConnectHandoff, showConnect } from "./connectWindow";
import { reopenInContainer } from "./container";
import { installDirenvNotifications, reloadEnvironment } from "./environment";
import { REMOTE_RESOURCES_WIDGET, RemoteResources } from "./RemoteResources";
import { RemoteStatus } from "./RemoteStatus";
import { closeConnectDialog } from "./model";
import { restorePorts, usePorts } from "./ports";
import { installReconnect, reconnectNow } from "./reconnect";
import { canMonitorRemoteHost, refreshRemoteResources, useRemoteResources } from "./resources";

/** Forwarded ports are available while this window is connected to an SSH host, a WSL distribution or a dev container. */
function trackPortsWindow(): () => void {
  let off: (() => void) | null = null;
  let session = useRemote.getState().session;
  const sync = () => {
    const next = useRemote.getState().session;
    const connected =
      next?.target.kind === "ssh" || next?.target.kind === "wsl" || next?.target.kind === "devContainer";
    if (connected && (next !== session || !off)) {
      usePorts.setState({ ports: [] });
      void restorePorts();
    }
    session = next;
    if (connected && !off) {
      off = registerToolWindow({
        id: "remote.ports",
        title: "Ports",
        icon: "web",
        anchor: "bottom",
        order: 40,
        stripe: "onUse",
        component: lazyComponent(() => import("./PortsView").then((m) => m.PortsView)),
      });
    } else if (!connected && off) {
      off();
      off = null;
      usePorts.setState({ ports: [] });
    }
  };
  sync();
  const unsubscribe = useRemote.subscribe(sync);
  return () => {
    unsubscribe();
    off?.();
  };
}

export function activate(): () => void {
  const syncResourcesWidget = () => {
    const { session, lost } = useRemote.getState();
    setStatusWidgetAvailable(
      REMOTE_RESOURCES_WIDGET.id,
      Boolean(session && lost === null && canMonitorRemoteHost(session)),
    );
  };
  syncResourcesWidget();
  const offResourcesAvailability = useRemote.subscribe(syncResourcesWidget);

  const disposers = [
    () => {
      offResourcesAvailability();
      setStatusWidgetAvailable(REMOTE_RESOURCES_WIDGET.id, false);
    },
    provideBackendBusyPrompt(() =>
      confirm({
        title: tx("Stop Remote Backend"),
        message: tx(
          "The backend of another OpenIDEA build, for example the one from before an upgrade, still has this project open, so this build can't open it. Stop that backend and open the project? Its terminals, runs and agent sessions end, and changes it hasn't saved are lost.",
        ),
        ok: tx("Stop Backend and Open"),
        icon: "warning",
      }),
    ),
    trackPortsWindow(),
    installReconnect(),
    installDirenvNotifications(),
    registerOverlay({ id: "remote.connect", component: ConnectHost }),
    installConnectHandoff(),
    registerStatusItem({
      id: "remote.location",
      title: "Remote Host",
      align: "left",
      priority: 100,
      component: RemoteStatus,
    }),
    registerStatusItem({
      ...REMOTE_RESOURCES_WIDGET,
      align: "left",
      priority: 99,
      component: RemoteResources,
    }),
    registerActions([
      {
        id: "remote.showResources",
        title: "Show Remote Host Resources",
        description: "Shows CPU, memory, network, disk and running processes of the remote host.",
        category: "View",
        icon: "info",
        keywords: ["ssh", "remote", "cpu", "memory", "ram", "network", "disk", "processes", "metrics", "resources"],
        when: "projectRemote && !remoteConnectionLost",
        run: async () => {
          const overrides = useProject.getState().settings?.appearance?.statusBarWidgets;
          if (!isStatusItemVisible(REMOTE_RESOURCES_WIDGET, overrides)) {
            await setStatusWidgetVisible(REMOTE_RESOURCES_WIDGET.id, true);
          }
          await refreshRemoteResources(true);
          useRemoteResources.setState({ popupOpen: true });
        },
      },
      {
        id: "remote.connect",
        title: "Remote Development…",
        description: "Opens a project folder on an SSH host; the IDE backend runs on that host.",
        category: "File",
        icon: "remote",
        keywords: ["ssh", "remote", "server", "gateway", "connect", "host"],
        run: () => showConnect(),
      },
      {
        id: "remote.reconnect",
        title: "Reconnect to Remote Host",
        description: "Connects this window to its remote project again after the connection was lost.",
        category: "File",
        keywords: ["ssh", "remote", "reconnect", "connection", "lost"],
        when: "remoteConnectionLost",
        run: () => reconnectNow(),
      },
      {
        id: "remote.disconnect",
        title: "Disconnect from Remote Host",
        category: "File",
        keywords: ["ssh", "remote", "close"],
        when: "projectOpen",
        run: async () => {
          if (!(await confirmLeaveProject(false))) return;
          try {
            await disconnectRemote();
          } catch (e) {
            maybeEditorService()?.cancelClose?.();
            throw e;
          }
        },
      },
      {
        id: "remote.stopBackend",
        title: "Stop Remote Backend",
        description:
          "Stops the remote IDE backend and its terminals, runs and agent sessions, then closes the project.",
        category: "File",
        keywords: ["ssh", "remote", "stop", "shutdown", "backend", "server"],
        when: "projectRemote && !remoteConnectionLost",
        run: async () => {
          const host = useRemote.getState().session?.host;
          if (!host) return;
          if (
            !(await confirm({
              title: tx("Stop Remote Backend"),
              message: tx`Stop the IDE backend on ${host} and terminate its running terminals, runs and agent sessions?`,
              ok: tx("Stop Backend"),
              icon: "warning",
            }))
          )
            return;
          if (!(await confirmLeaveProject(false))) return;
          try {
            await stopRemoteBackend();
          } catch (e) {
            maybeEditorService()?.cancelClose?.();
            throw e;
          }
        },
      },
      {
        id: "remote.reopenInContainer",
        title: "Reopen in Container",
        description:
          "Builds or starts the project's dev container (devcontainer.json) with the Dev Containers CLI and opens the project in it.",
        category: "File",
        icon: "folder",
        keywords: ["devcontainer", "dev container", "docker", "container", "remote"],
        when: "projectOpen",
        run: () => reopenInContainer(),
      },
      {
        id: "remote.reloadEnvironment",
        title: "Reload Environment",
        description:
          "Reads the login shell's environment (and devcontainer.json remoteEnv on a remote host) again for new terminals and processes.",
        category: "File",
        keywords: [
          "env",
          "environment",
          "variables",
          "path",
          "shell",
          "remoteEnv",
          "devcontainer",
          "direnv",
          "envrc",
          "nix",
          "flake",
          "reload",
        ],
        when: "projectOpen",
        run: () => reloadEnvironment(),
      },
    ]),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    closeConnectDialog();
  };
}
