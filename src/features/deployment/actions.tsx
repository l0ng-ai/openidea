/** Deployment actions: upload / download / delete / sync / open the deployed URL. */
import { executeAction, registerActions } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { call, commands, isCancelled, nextRequestId, type SyncAction, type TransferReport } from "@/platform/ipc";
import { txTemplate, useTxTemplate } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { relativePath, useProject } from "@/platform/project";
import type { AutoUploadValid, DeploymentServerValid } from "@/platform/remoteSettings";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications, projectViewSelection, toolWindowService } from "@/workbench/contributions";
import { chooseItem } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { initialSyncChoices, resolveServer, serverLabel, summarizeReport, targetPaths } from "./model";
import { withSsh } from "./ssh";
import { REMOTE_HOST_WINDOW, patchSync, useDeployment } from "./store";
import styles from "./Deployment.module.css";

const GROUP = "tools";
const CATEGORY = "Deployment";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const projectRoot = () => useProject.getState().project?.root ?? null;
const deployment = () => workflowSettings().deployment;

/** The files an action works on (menu argument, project view selection or the editor's file). */
export function actionTargets(arg: unknown): string[] {
  const editorPath = getContext().editorPath;
  return targetPaths(arg, {
    part: useDeployment.getState().part,
    selection: projectViewSelection(),
    editorPath: typeof editorPath === "string" ? editorPath : null,
    projectRoot: projectRoot(),
  });
}

function notifyNoServers() {
  notifications().notify({
    level: "warning",
    title: "No deployment server configured",
    group: GROUP,
    key: "deployment.noServer",
    actions: [{ label: "Configure…", run: () => void executeAction("deployment.configure") }],
  });
}

function notifyNoTargets() {
  notifications().notify({
    level: "info",
    title: "Select files in the Project view or open a file in the editor",
    group: GROUP,
    key: "deployment.noTarget",
  });
}

/** Asks which server to use (the only one without asking). */
async function pickServer(title: string): Promise<DeploymentServerValid | null> {
  const servers = deployment().servers;
  if (!servers.length) {
    notifyNoServers();
    return null;
  }
  if (servers.length === 1) return servers[0]!;
  const labels = servers.map(serverLabel);
  const picked = await chooseItem({ title, items: labels });
  return picked === null ? null : (servers[labels.indexOf(picked)] ?? null);
}

/** The default server; asks when none is marked default and there are several. */
async function defaultServer(title: string): Promise<DeploymentServerValid | null> {
  return resolveServer(deployment(), null) ?? pickServer(title);
}

function ReportBody({ report }: { report: TransferReport }) {
  const txt = useTxTemplate();
  const root = projectRoot();
  const shown = report.errors.slice(0, 10);
  return (
    <div className={styles.report}>
      {report.skipped > 0 && <div>{txt(`Skipped: ${report.skipped}`)}</div>}
      {shown.length > 0 && (
        <ul className={styles.reportErrors}>
          {shown.map((e, i) => (
            <li key={i}>
              <span className={styles.mono}>{root ? relativePath(root, e.path) : e.path}</span>: {e.message}
            </li>
          ))}
        </ul>
      )}
      {report.errors.length > shown.length && <div>{txt(`and ${report.errors.length - shown.length} more`)}</div>}
    </div>
  );
}

export function showReport(
  report: TransferReport,
  verb: "upload" | "download" | "delete" | "sync",
  server: DeploymentServerValid,
) {
  const s = summarizeReport(report, verb, serverLabel(server));
  notifications().notify({
    level: s.level,
    title: s.title.replace("{n}", String(s.params.n)).replace("{server}", s.params.server),
    body: report.errors.length || report.skipped ? <ReportBody report={report} /> : undefined,
    group: GROUP,
    key: `deployment.${verb}`,
  });
}

function showFailure(title: string, server: DeploymentServerValid, e: unknown) {
  if (isCancelled(e)) return;
  notifications().notify({
    level: "error",
    title: title.replace("{server}", serverLabel(server)),
    body: errorText(e),
    group: GROUP,
    key: "deployment.failure",
  });
}

async function transfer(direction: "upload" | "download", server: DeploymentServerValid | null, paths: string[]) {
  if (!server) return;
  const request = nextRequestId();
  try {
    const report = await withSsh(server.sshConfig, () =>
      call(
        direction === "upload"
          ? commands.deployUpload(paths, server.id, request)
          : commands.deployDownload(paths, server.id, request),
      ),
    );
    showReport(report, direction, server);
  } catch (e) {
    showFailure(direction === "upload" ? "Cannot upload to {server}" : "Cannot download from {server}", server, e);
  }
}

/** Downloads the remote counterparts of `paths` (Remote Host › Download to Project). */
export function downloadPaths(server: DeploymentServerValid, paths: string[]) {
  return transfer("download", server, paths);
}

async function deleteRemote(paths: string[]) {
  const server = await defaultServer("Delete from Server");
  if (!server) return;
  const root = projectRoot();
  const names = paths.map((p) => (root ? relativePath(root, p) || "/" : p));
  const ok = await confirm({
    title: "Delete from Server",
    message: txTemplate(
      names.length === 1
        ? `Delete the remote copy of ${names[0]} from ${serverLabel(server)}?`
        : `Delete the remote copies of ${names.length} items from ${serverLabel(server)}?`,
    ),
    ok: "Delete",
    icon: "warning",
  });
  if (!ok) return;
  try {
    const report = await withSsh(server.sshConfig, () => call(commands.deployDeleteRemote(paths, server.id)));
    showReport(report, "delete", server);
  } catch (e) {
    showFailure("Cannot delete from {server}", server, e);
  }
}

/** Opens the Sync dialog for `path` and compares it with `server`. */
export async function openSync(server: DeploymentServerValid, path: string) {
  const request = nextRequestId();
  useDeployment.setState({
    sync: {
      server: server.id,
      serverName: serverLabel(server),
      path,
      request,
      entries: null,
      error: null,
      choices: {},
      hideSame: true,
      running: false,
    },
  });
  try {
    const entries = await withSsh(server.sshConfig, () => call(commands.deployCompare(path, server.id, request)));
    if (useDeployment.getState().sync?.request !== request) return;
    patchSync({ entries, choices: initialSyncChoices(entries), request: null });
  } catch (e) {
    if (useDeployment.getState().sync?.request !== request) return;
    if (isCancelled(e)) useDeployment.setState({ sync: null });
    else patchSync({ error: errorText(e), request: null });
  }
}

/** Closes the Sync dialog, cancelling a running comparison. */
export function closeSync() {
  const request = useDeployment.getState().sync?.request;
  if (request != null) void commands.cancelRequest(request);
  useDeployment.setState({ sync: null });
}

export async function runSync(steps: { path: string; action: SyncAction }[]) {
  const sync = useDeployment.getState().sync;
  const server = sync && deployment().servers.find((s) => s.id === sync.server);
  if (!sync || !server) return;
  const request = nextRequestId();
  patchSync({ running: true, request });
  try {
    const report = await withSsh(server.sshConfig, () => call(commands.deploySync(steps, server.id, request)));
    useDeployment.setState({ sync: null });
    showReport(report, "sync", server);
  } catch (e) {
    if (isCancelled(e)) patchSync({ running: false, request: null });
    else patchSync({ running: false, request: null, error: errorText(e) });
  }
}

async function openInBrowser(paths: string[]) {
  const path = paths[0];
  if (!path) return notifyNoTargets();
  try {
    const info = await call(commands.deployInfo(path, null));
    if (!info?.webUrl) {
      notifications().notify({
        level: "info",
        title: info ? "No web server URL for this file" : "This file is not mapped to the default server",
        group: GROUP,
        key: "deployment.openInBrowser",
        actions: [{ label: "Configure…", run: () => void executeAction("deployment.configure") }],
      });
      return;
    }
    await openExternalUrl(info.webUrl);
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open in browser", body: errorText(e), group: GROUP });
  }
}

export function autoUploadOn(): boolean {
  return deployment().autoUpload !== "never";
}

async function setAutoUpload(value: AutoUploadValid) {
  try {
    const settings = await call(commands.settingsSet("project", "deployment.autoUpload", JSON.stringify(value)));
    useProject.setState({ settings });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot change automatic upload",
      body: errorText(e),
      group: GROUP,
    });
  }
}

/** Runs `fn` with the targets, or explains how to pick some. */
const withTargets = (fn: (paths: string[]) => unknown) => (c: { arg?: unknown }) => {
  const paths = actionTargets(c.arg);
  if (!paths.length) return notifyNoTargets();
  void fn(paths);
};

export function registerDeploymentActions(): () => void {
  const when = "projectOpen";
  return registerActions([
    {
      id: "deployment.uploadToDefault",
      title: "Upload to Default Server",
      description: "Upload the selected files and folders to the default deployment server",
      category: CATEGORY,
      icon: "export",
      when,
      keywords: ["deploy", "sftp", "upload", "remote"],
      run: withTargets(async (paths) => transfer("upload", await defaultServer("Upload to"), paths)),
    },
    {
      id: "deployment.uploadTo",
      title: "Upload to…",
      description: "Upload the selected files and folders to a deployment server",
      category: CATEGORY,
      when,
      keywords: ["deploy", "sftp", "upload", "remote"],
      run: withTargets(async (paths) => transfer("upload", await pickServer("Upload to"), paths)),
    },
    {
      id: "deployment.downloadFromDefault",
      title: "Download from Default Server",
      description: "Replace the selected files and folders with their copies on the default deployment server",
      category: CATEGORY,
      when,
      keywords: ["deploy", "sftp", "download", "remote"],
      run: withTargets(async (paths) => transfer("download", await defaultServer("Download from"), paths)),
    },
    {
      id: "deployment.downloadFrom",
      title: "Download from…",
      description: "Replace the selected files and folders with their copies on a deployment server",
      category: CATEGORY,
      when,
      keywords: ["deploy", "sftp", "download", "remote"],
      run: withTargets(async (paths) => transfer("download", await pickServer("Download from"), paths)),
    },
    {
      id: "deployment.syncWith",
      title: "Sync with Deployed to…",
      description: "Compare local files with a deployment server and synchronize them",
      category: CATEGORY,
      when,
      keywords: ["deploy", "sftp", "compare", "synchronize", "remote", "diff"],
      run: ({ arg }) => {
        const paths = actionTargets(arg);
        const target = paths[0] ?? projectRoot();
        if (!target) return;
        void pickServer("Sync with Deployed to").then((server) => server && openSync(server, target));
      },
    },
    {
      id: "deployment.deleteFromServer",
      title: "Delete from Server",
      description: "Delete the remote copies of the selected files and folders on the default server",
      category: CATEGORY,
      icon: "trash",
      when,
      keywords: ["deploy", "sftp", "remove", "remote"],
      run: withTargets(deleteRemote),
    },
    {
      id: "deployment.toggleAutoUpload",
      title: "Automatic Upload",
      description: "Upload changed files to the default server automatically",
      category: CATEGORY,
      when,
      keywords: ["deploy", "sftp", "auto upload", "on save", "toggle"],
      toggled: autoUploadOn,
      run: () => setAutoUpload(autoUploadOn() ? "never" : "always"),
    },
    {
      id: "deployment.browseRemoteHost",
      title: "Browse Remote Host",
      description: "Show the files of a deployment server in the Remote Host tool window",
      category: CATEGORY,
      icon: "web",
      when,
      keywords: ["deploy", "sftp", "remote host", "server files"],
      run: () => toolWindowService().show(REMOTE_HOST_WINDOW, true),
    },
    {
      id: "deployment.openInBrowser",
      title: "Open in Browser (Deployed)",
      description: "Open the deployed URL of the file on the default server's web server",
      category: CATEGORY,
      icon: "web",
      when,
      keywords: ["deploy", "web server", "url", "browser"],
      run: withTargets(openInBrowser),
    },
    {
      id: "deployment.configure",
      title: "Deployment Configuration…",
      description: "Edit the deployment servers and options",
      category: CATEGORY,
      icon: "settings",
      when,
      keywords: ["deploy", "sftp", "servers", "settings"],
      run: () => void executeAction("file.settings", "build.deployment"),
    },
  ]);
}
