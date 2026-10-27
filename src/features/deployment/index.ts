/**
 * Deployment over SFTP: upload / download / sync project files with the
 * servers of Settings › Build, Execution, Deployment › Deployment, and the
 * Remote Host tool window. Transfers, automatic upload and remote deletes run
 * in Rust (`ide-remote`).
 */
import { useContextKeys } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { lazyComponent, type MenuItem } from "@/ui";
import { registerMenuGroup, registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { executeAction } from "@/platform/actions";
import { autoUploadOn, registerDeploymentActions } from "./actions";
import { DeploymentDialogs } from "./Dialogs";
import { REMOTE_HOST_WINDOW, useDeployment } from "./store";

/** Deployed URL of the path the last menu was prepared for. */
let webUrlFor: { path: string; url: string | null } | null = null;

function deploymentMenu(paths: string[]): MenuItem[] {
  const root = useProject.getState().project?.root;
  const { servers } = workflowSettings().deployment;
  if (!root || !servers.length || !paths.length) return [];
  if (!paths.every((p) => p === root || p.startsWith(`${root}/`))) return [];
  const arg = { paths };
  const single = paths.length === 1 ? paths[0]! : null;
  const webUrl = single && webUrlFor?.path === single ? webUrlFor.url : null;
  return [
    {
      id: "deployment",
      label: "Deployment",
      icon: "web",
      submenu: [
        { kind: "action", action: "deployment.uploadToDefault", arg },
        { kind: "action", action: "deployment.uploadTo", arg },
        { kind: "action", action: "deployment.downloadFromDefault", arg },
        { kind: "action", action: "deployment.downloadFrom", arg },
        { kind: "action", action: "deployment.syncWith", arg },
        { kind: "action", action: "deployment.deleteFromServer", arg },
        { kind: "separator" },
        ...(webUrl ? [{ kind: "action", action: "deployment.openInBrowser", arg } as MenuItem] : []),
        { kind: "action", action: "deployment.browseRemoteHost" },
        {
          id: "deployment.toggleAutoUpload",
          label: "Automatic Upload",
          checked: autoUploadOn(),
          run: () => void executeAction("deployment.toggleAutoUpload"),
        },
        { kind: "action", action: "deployment.configure", label: "Configuration…" },
      ],
    },
  ];
}

export function activate(): () => void {
  // Actions run from Find Action target what had focus before: the project view or the editor.
  const unsubFocus = useContextKeys.subscribe((ctx, prev) => {
    if (ctx.projectViewFocus && !prev.projectViewFocus) useDeployment.setState({ part: "project" });
    else if ((ctx.editorFocus && !prev.editorFocus) || (ctx.editorTextFocus && !prev.editorTextFocus))
      useDeployment.setState({ part: "editor" });
  });
  // A reopened project starts with a fresh backend: forget the old one's remote trees.
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) useDeployment.setState({ trees: {}, remoteServer: null, sync: null });
  });
  const disposers = [
    unsubFocus,
    unsubProject,
    registerDeploymentActions(),
    registerToolWindow({
      id: REMOTE_HOST_WINDOW,
      title: "Remote Host",
      icon: "web",
      anchor: "right",
      order: 30,
      requiresProject: true,
      stripe: "onUse",
      component: lazyComponent(() => import("./RemoteHostView").then((m) => m.RemoteHostView)),
    }),
    registerOverlay({ id: "deployment.dialogs", component: DeploymentDialogs }),
    registerMenuGroup({
      id: "deployment",
      menus: ["projectView", "editor", "editorTab"],
      order: 60,
      items: (_menu, { paths }) => deploymentMenu(paths),
      prepare: async (_menu, { paths }) => {
        const single = paths.length === 1 ? paths[0]! : null;
        if (!single || !workflowSettings().deployment.servers.length) return;
        const info = await call(commands.deployInfo(single, null)).catch(() => null);
        webUrlFor = { path: single, url: info?.webUrl ?? null };
      },
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
