/**
 * Remote development: a window whose project lives on an SSH host. The backend
 * (`openidea-server`) runs there and this window routes its commands to it
 * (platform/remote.ts).
 */
import { registerActions } from "@/platform/actions";
import { disconnectRemote } from "@/platform/remote";
import { maybeEditorService, registerOverlay } from "@/workbench/contributions";
import { confirmLeaveProject } from "@/platform/project";
import { ConnectHost } from "./ConnectDialog";
import { reloadEnvironment } from "./environment";
import { closeConnectDialog, openConnectDialog } from "./model";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "remote.connect", component: ConnectHost }),
    registerActions([
      {
        id: "remote.connect",
        title: "Remote Development…",
        description: "Opens a project folder on an SSH host; the IDE backend runs on that host.",
        category: "File",
        icon: "folder",
        keywords: ["ssh", "remote", "server", "gateway", "connect", "host"],
        run: () => openConnectDialog(),
      },
      {
        id: "remote.disconnect",
        title: "Disconnect from Remote Host",
        category: "File",
        keywords: ["ssh", "remote", "close"],
        when: "projectOpen",
        run: async () => {
          if (!(await confirmLeaveProject())) return;
          try {
            await disconnectRemote();
          } catch (e) {
            maybeEditorService()?.cancelClose?.();
            throw e;
          }
        },
      },
      {
        id: "remote.reloadEnvironment",
        title: "Reload Environment",
        description:
          "Reads the login shell's environment (and devcontainer.json remoteEnv on a remote host) again for new terminals and processes.",
        category: "File",
        keywords: ["env", "environment", "variables", "path", "shell", "remoteEnv", "devcontainer", "reload"],
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
