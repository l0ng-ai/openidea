/**
 * `java.downloadJdk` (arg: `DownloadJdkArgs`): the one-click fix offered where
 * jdtls, a run configuration or a Maven / Gradle sync lacks a new enough JDK.
 * Downloads Eclipse Temurin N into the IDE's JDK folder (found by JDK detection
 * from then on), makes it the language server JDK when a too-old one is chosen
 * there, and lets the backend restart jdtls on it. Progress and Cancel live in
 * the status bar's background tasks.
 */
import type { Sdk } from "@/bindings";
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands, isCancelled, isTauri, onIdeEvent } from "@/platform/ipc";
import {
  DOWNLOAD_JDK_ACTION,
  downloadJdk,
  downloadJdkActions,
  isDownloadJdkArgs,
  requiredJdk,
  TEMURIN,
  type DownloadJdkArgs,
  type JdkDownload,
} from "@/platform/jdk";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { queueTask, upsertTask } from "@/workbench/tasks";
import { DOWNLOAD_QUEUE } from "./store";
import { tx } from "@/platform/i18n";

const JAVA_SETTINGS = "languages.java";
const running = new Map<number, Promise<Sdk | null>>();

/** Makes `home` the language server JDK if one that can't run jdtls is chosen (Auto finds the new JDK by itself). */
export async function chooseForLanguageServer(home: string): Promise<void> {
  const chosen = useProject.getState().settings?.languages?.java?.jdtlsJdk?.trim();
  if (!chosen || chosen === home) return;
  // The project value wins over the global one, so writing it there always takes effect.
  const scope = useProject.getState().project ? "project" : "global";
  const settings = await call(commands.settingsSet(scope, "languages.java.jdtlsJdk", JSON.stringify(home)));
  useProject.setState({ settings });
}

export function downloadJdkFor(args: DownloadJdkArgs): Promise<Sdk | null> {
  const existing = running.get(args.version);
  if (existing) return existing;
  const title = `Downloading JDK ${args.version}`;
  const taskId = `jdk-download:${args.version}`;
  const key = `jdk-download-${args.version}`;
  const p = (async () => {
    try {
      // Waits for the downloads ahead of it; cancelling it there means it never starts.
      const sdk = await queueTask(DOWNLOAD_QUEUE, { id: taskId, title }, () => {
        const cancel = () => job.cancel();
        upsertTask({ id: taskId, title, message: "Eclipse Temurin", fraction: null, done: false, cancel });
        const job: JdkDownload = downloadJdk(TEMURIN, args.version, null, (e) => {
          const message = e.type === "line" ? e.text : e.message;
          const fraction = e.type === "progress" ? e.fraction : null;
          upsertTask({ id: taskId, title, message, fraction, done: false, cancel });
        });
        return job.promise;
      });
      if (args.languageServer) await chooseForLanguageServer(sdk.path);
      notifications().notify({
        group: "tools",
        level: "info",
        key,
        title: `${sdk.name} downloaded`,
        body: args.languageServer
          ? "The Java language server restarts on it."
          : tx`Installed in ${sdk.path}; it is used for projects targeting Java ${args.version}.`,
      });
      return sdk;
    } catch (e) {
      if (isCancelled(e)) return null;
      notifications().notify({
        group: "tools",
        level: "error",
        key,
        title: `Failed to download JDK ${args.version}`,
        body: e instanceof Error ? e.message : String(e),
        actions: [{ label: "Java Settings…", run: () => void executeAction("file.settings", JAVA_SETTINGS) }],
      });
      return null;
    } finally {
      upsertTask({ id: taskId, title, message: null, fraction: 1, done: true });
      running.delete(args.version);
    }
  })();
  running.set(args.version, p);
  return p;
}

/** A language server that can't start without a newer JDK (jdtls): say so once, with the one-click download. */
export function installJdkPrompts(): () => void {
  const prompted = new Set<string>();
  return onIdeEvent("languageServer", (e) => {
    if (e.status !== "misconfigured") return;
    const need = requiredJdk(e.message);
    if (!need || prompted.has(`${e.name}:${need.version}`)) return;
    prompted.add(`${e.name}:${need.version}`);
    notifications().notify({
      group: "lsp",
      level: "warning",
      key: `jdk-required-${e.name}`,
      sticky: true,
      title: `${e.name} needs JDK ${need.version} to run`,
      body: e.message ?? undefined,
      actions: [
        ...downloadJdkActions(e.message),
        { label: "Java Settings…", run: () => void executeAction("file.settings", JAVA_SETTINGS) },
      ],
    });
  });
}

export function registerJdkActions(): () => void {
  return registerActions([
    {
      id: DOWNLOAD_JDK_ACTION,
      title: "Download JDK…",
      category: "Java",
      hidden: true,
      // Without a version: the Java settings, whose JDK pickers offer Download JDK….
      run: async ({ arg }) => {
        if (isDownloadJdkArgs(arg) && isTauri()) await downloadJdkFor(arg);
        else await executeAction("file.settings", JAVA_SETTINGS);
      },
    },
  ]);
}
