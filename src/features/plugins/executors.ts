/**
 * Plugin executors (`executor = "<title>"` on `[[contributes.javaAgents]]`, API 1.18):
 * "Run '<config>' with <title>" and "Debug '<config>' with <title>" beside Run and Debug
 * for the JVM configurations the agent loads into (the run widget's ⋮ menu, the gutter,
 * the context menus' More Run/Debug and the Services tree). The launch carries the
 * plugin's id; the host adds that plugin's agent to it, and to no other launch.
 */
import type { PluginInfo } from "@/bindings";
import { executeAction, registerActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { RunConfig } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import {
  notifications,
  registerRunExecutor,
  type ExecutorLaunch,
  type RunExecutorContribution,
} from "@/workbench/contributions";
import { usePlugins } from "./store";

/** Configuration kinds whose JVM gets plugin agents (`ide_run::java_agent::KINDS`). */
const KINDS = ["application", "spring-boot", "jar-application"];

export const pluginExecutorId = (pluginId: string, debug: boolean) => `plugin:${pluginId}${debug ? ":debug" : ""}`;

const actionId = (pluginId: string, debug: boolean) => `pluginExecutor.${pluginId}.${debug ? "debug" : "run"}`;

export interface PluginExecutor {
  pluginId: string;
  pluginName: string;
  title: string;
  /** The agent jar is approved (`java.agent` granted, jar unchanged). */
  approved: boolean;
}

/** Executors of the enabled plugins that declare one. */
export function pluginExecutors(plugins: readonly PluginInfo[]): PluginExecutor[] {
  return plugins.flatMap((p) =>
    p.enabled && p.javaAgent?.executor
      ? [{ pluginId: p.id, pluginName: p.name, title: p.javaAgent.executor, approved: p.javaAgent.approved }]
      : [],
  );
}

/** What "Run/Debug with <title>" launches: the configuration marked with the plugin's id. */
export function executorLaunch(e: PluginExecutor, config: RunConfig): RunConfig | null {
  if (!e.approved) {
    notifications().notify({
      group: "run",
      level: "warning",
      key: `plugin-executor-${e.pluginId}`,
      title: tx`${e.title} needs the Java agent of ${e.pluginName}`,
      body: tx`Allow the java.agent permission of ${e.pluginName} in Settings › Plugins, then try again.`,
      userInitiated: true,
      actions: [{ label: "Plugins…", run: () => void executeAction("plugins.settings") }],
    });
    return null;
  }
  if (config.target) {
    notifications().notify({
      group: "run",
      level: "warning",
      key: `plugin-executor-${e.pluginId}`,
      title: tx`Cannot run '${config.name}' with ${e.title}`,
      body: tx`Plugin Java agents load only into JVMs started on this machine. Choose “Local machine” under “Run on”.`,
      userInitiated: true,
      actions: [{ label: "Edit Configuration…", run: () => void executeAction("run.editConfigs", config.id) }],
    });
    return null;
  }
  return { ...config, executor: e.pluginId };
}

function executor(e: PluginExecutor, debug: boolean): RunExecutorContribution {
  return {
    id: pluginExecutorId(e.pluginId, debug),
    label: (name) => (debug ? tx`Debug '${name}' with ${e.title}` : tx`Run '${name}' with ${e.title}`),
    icon: debug ? "debug" : "run",
    action: actionId(e.pluginId, debug),
    order: debug ? 101 : 100,
    debug,
    checksTarget: true,
    // All three debug: Application / Spring Boot through the Java debugger, JAR Application through JDWP.
    supports: (config) => KINDS.includes(config.kind) && !isRemoteWindow(),
    prepare: async (config): Promise<ExecutorLaunch | null> => {
      const launch = executorLaunch(e, config);
      return launch ? { launch, finished: () => {} } : null;
    },
  };
}

/**
 * What the Run/Debug with <title> actions launch. A plugin command passes text: a configuration
 * id, or the argument of a `services.context` / `services.toolbar` command as it came (the first
 * selected service's configuration); with no such configuration the chooser opens. Objects are
 * `run.withExecutor`'s own `{ config?, context? }`.
 */
export function executorTarget(arg: unknown): { config?: unknown; context?: unknown } {
  if (arg && typeof arg === "object") return arg;
  if (typeof arg !== "string" || !arg) return {};
  if (arg.trimStart().startsWith("{")) {
    try {
      const services = (JSON.parse(arg) as { services?: unknown }).services;
      const id = Array.isArray(services)
        ? services.find((s) => typeof s?.runConfigurationId === "string")?.runConfigurationId
        : undefined;
      return { config: typeof id === "string" ? id : "" };
    } catch {
      return { config: "" };
    }
  }
  return { config: arg };
}

function register(e: PluginExecutor): () => void {
  const disposers = [false, true].flatMap((debug) => [
    registerRunExecutor(executor(e, debug)),
    registerActions([
      {
        id: actionId(e.pluginId, debug),
        title: debug ? tx`Debug with ${e.title}` : tx`Run with ${e.title}`,
        description: tx`Launches the selected configuration with the Java agent of ${e.pluginName}`,
        category: "Run",
        icon: debug ? "debug" : "run",
        when: "projectOpen",
        run: ({ arg }) =>
          executeAction("run.withExecutor", {
            executor: pluginExecutorId(e.pluginId, debug),
            ...executorTarget(arg),
          }).then(() => undefined),
      },
    ]),
  ]);
  return () => disposers.forEach((d) => d());
}

/** Keeps the executors in line with the installed plugins. */
export function syncPluginExecutors(): () => void {
  const live = new Map<string, { sig: string; dispose: () => void }>();
  const sync = (plugins: readonly PluginInfo[]) => {
    const next = new Map(pluginExecutors(plugins).map((e) => [e.pluginId, e]));
    for (const [id, entry] of live) {
      const e = next.get(id);
      if (!e || JSON.stringify(e) !== entry.sig) {
        entry.dispose();
        live.delete(id);
      }
    }
    for (const [id, e] of next) {
      if (!live.has(id)) live.set(id, { sig: JSON.stringify(e), dispose: register(e) });
    }
  };
  sync(usePlugins.getState().plugins);
  const unsubscribe = usePlugins.subscribe((s, prev) => {
    if (s.plugins !== prev.plugins) sync(s.plugins);
  });
  return () => {
    unsubscribe();
    for (const entry of live.values()) entry.dispose();
    live.clear();
  };
}
