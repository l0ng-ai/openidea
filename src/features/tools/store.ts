/** Tool list + running installs. Installs show in the status-bar task list too. */
import { create } from "zustand";
import type { RequestId, ToolInfo } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { isCancelled, nextRequestId } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { cancelTask, queueTask, upsertTask, useTasks } from "@/workbench/tasks";
import { toolsBackend } from "./backend";
import { tx } from "@/platform/i18n";

export const SETTINGS_PAGE_ID = "languages.servers";
/** Tool installs and JDK downloads take turns (one network download / package manager at a time). */
export const DOWNLOAD_QUEUE = "downloads";
const MAX_LOG_LINES = 400;

export interface InstallJob {
  request: RequestId;
  lines: string[];
  fraction: number | null;
  message: string | null;
}

interface ToolsState {
  tools: ToolInfo[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  jobs: Readonly<Record<string, InstallJob>>;
  /** Output of the last finished install per tool (kept for the log view). */
  logs: Readonly<Record<string, { lines: string[]; error: string | null }>>;
}

export const useTools = create<ToolsState>(() => ({
  tools: [],
  loaded: false,
  loading: false,
  error: null,
  jobs: {},
  logs: {},
}));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let refreshing: Promise<void> | null = null;

export function refreshTools(): Promise<void> {
  refreshing ??= (async () => {
    useTools.setState({ loading: true });
    try {
      const tools = await toolsBackend().list();
      useTools.setState({ tools, loaded: true, error: null });
    } catch (e) {
      useTools.setState({ error: errorText(e), loaded: true });
    } finally {
      useTools.setState({ loading: false });
      refreshing = null;
    }
  })();
  return refreshing;
}

function upsertTool(info: ToolInfo) {
  useTools.setState((s) => {
    const i = s.tools.findIndex((t) => t.name === info.name);
    const tools = [...s.tools];
    if (i >= 0) tools[i] = info;
    else tools.push(info);
    return { tools };
  });
}

function patchJob(name: string, f: (j: InstallJob) => InstallJob) {
  useTools.setState((s) => {
    const j = s.jobs[name];
    return j ? { jobs: { ...s.jobs, [name]: f(j) } } : s;
  });
}

function endJob(name: string, error: string | null) {
  useTools.setState((s) => {
    const { [name]: job, ...jobs } = s.jobs;
    return { jobs, logs: { ...s.logs, [name]: { lines: job?.lines ?? [], error } } };
  });
}

const running = new Map<string, Promise<ToolInfo | null>>();

export function toolByName(name: string): ToolInfo | undefined {
  return useTools.getState().tools.find((t) => t.name === name);
}

/**
 * Installs `name` (or reinstalls it). Resolves with the new info, or null on
 * failure / cancellation (already reported). Restarts language servers of that
 * name afterwards so open files get code insight right away.
 */
export function installTool(name: string, opts: { notificationKey?: string } = {}): Promise<ToolInfo | null> {
  const existing = running.get(name);
  if (existing) return existing;
  const display = toolByName(name)?.displayName ?? name;
  const request = nextRequestId();
  const taskId = `tools:${name}`;
  const key = opts.notificationKey ?? `tools-install-${name}`;
  useTools.setState((s) => ({ jobs: { ...s.jobs, [name]: { request, lines: [], fraction: null, message: null } } }));
  const title = tx`Installing ${display}`;
  const cancel = () => toolsBackend().cancel(request);
  const task = (message: string | null, fraction: number | null) =>
    upsertTask({ id: taskId, title, message, fraction, done: false, cancel });

  const p = (async () => {
    try {
      // Downloads and package managers run one at a time; the rest wait, cancellable.
      const info = await queueTask(DOWNLOAD_QUEUE, { id: taskId, title }, () => {
        task(null, null);
        return toolsBackend().install(name, request, (e) => {
          if (e.type === "line") {
            patchJob(name, (j) => ({ ...j, lines: [...j.lines, e.text].slice(-MAX_LOG_LINES), message: e.text }));
            task(e.text, null);
          } else {
            patchJob(name, (j) => ({ ...j, fraction: e.fraction, message: e.message }));
            task(e.message, e.fraction);
          }
        });
      });
      upsertTool(info);
      endJob(name, null);
      void toolsBackend()
        .restartServers(name)
        .catch(() => {});
      notifications().notify({
        group: "tools",
        level: "info",
        title: `${info.displayName} installed`,
        body: info.version ? tx`Version ${info.version}` : undefined,
        key,
      });
      // Shared packages (e.g. vscode-langservers-extracted) change sibling rows too.
      void refreshTools();
      return info;
    } catch (e) {
      if (isCancelled(e)) {
        endJob(name, "Cancelled");
        return null;
      }
      const message = errorText(e);
      endJob(name, message);
      notifications().notify({
        group: "tools",
        level: "error",
        title: `Failed to install ${display}`,
        body: message,
        key,
        actions: [{ label: "Show details", run: () => void executeAction("file.settings", SETTINGS_PAGE_ID) }],
      });
      return null;
    } finally {
      upsertTask({ id: taskId, title, message: null, fraction: 1, done: true });
      running.delete(name);
    }
  })();
  running.set(name, p);
  return p;
}

/** Cancels the install of `name`, queued or running (as the task's Cancel does). */
export function cancelInstall(name: string) {
  const taskId = `tools:${name}`;
  if (useTasks.getState().tasks.some((t) => t.id === taskId)) return cancelTask(taskId);
  const job = useTools.getState().jobs[name];
  if (job) toolsBackend().cancel(job.request);
}

export async function uninstallTool(name: string): Promise<boolean> {
  try {
    upsertTool(await toolsBackend().uninstall(name));
    void refreshTools();
    return true;
  } catch (e) {
    notifications().notify({
      group: "tools",
      level: "error",
      title: `Failed to uninstall ${toolByName(name)?.displayName ?? name}`,
      body: errorText(e),
    });
    return false;
  }
}

export const STATUS_LABEL: Record<ToolInfo["status"], string> = {
  installed: "Installed",
  onPath: "On PATH",
  custom: "Custom",
  missing: "Missing",
};
