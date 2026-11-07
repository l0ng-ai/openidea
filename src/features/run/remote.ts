/**
 * Run targets (Settings › Run Targets): configurations with a `target` run over
 * SSH or in a Docker / Compose container. Labels, the debug and executor guards,
 * and the connection remedies of `runStart`.
 */
import { executeAction } from "@/platform/actions";
import { tx, txTemplate } from "@/platform/i18n";
import { call, commands, IpcError, type RunConfig } from "@/platform/ipc";
import { inContainer, type RunTargetValid, type SshConfigValid } from "@/platform/remoteSettings";
import { useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { promptSecret } from "./dialogs";

/** The run target `config` runs on; undefined when it runs locally or the target is gone. */
export function targetOf(
  config: Pick<RunConfig, "target">,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): RunTargetValid | undefined {
  return config.target ? targets.find((t) => t.id === config.target) : undefined;
}

/** Display name of the target `config` runs on (its id when missing); null when local. */
export function targetName(
  config: Pick<RunConfig, "target">,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): string | null {
  if (!config.target) return null;
  const t = targetOf(config, targets);
  return t ? t.name.trim() || t.id : config.target;
}

/** `name @ target` for configurations on a run target, else the name. */
export function remoteLabel(
  config: Pick<RunConfig, "name" | "target">,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): string {
  const t = targetName(config, targets);
  return t ? `${config.name} @ ${t}` : config.name;
}

/** `remoteLabel` that re-renders when the run targets change. */
export function useRemoteLabel(): (config: Pick<RunConfig, "name" | "target">) => string {
  const targets = useWorkflowSettings((s) => s.runTargets);
  return (config) => remoteLabel(config, targets);
}

/** `config` running on `target` (empty: this machine, the key is dropped). */
export function withTarget(config: RunConfig, target: string): RunConfig {
  const { target: _previous, ...rest } = config;
  return target ? { ...rest, target } : rest;
}

/** A Python configuration on a Docker / Compose target: debugged in its container (`debugInContainer`). */
export function containerDebuggable(
  config: RunConfig,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): boolean {
  const target = targetOf(config, targets);
  return !!target && inContainer(target) && config.debugAdapter === "debugpy";
}

/**
 * Debugging on run targets isn't supported, except Python in containers: tells so
 * (offering Run) and returns true when `config` can't be debugged where it runs.
 */
export function remoteDebugBlocked(
  config: RunConfig,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): boolean {
  if (!config.target || containerDebuggable(config, targets)) return false;
  const target = targetName(config, targets) ?? config.target;
  const container = targetOf(config, targets);
  notifications().notify({
    group: "run",
    level: "warning",
    key: "run.remoteDebug",
    title:
      container && inContainer(container)
        ? "Only Python can be debugged in containers"
        : "Debugging on run targets is not supported",
    body: txTemplate(
      `'${config.name}' runs on ${target}. Run it, or choose “Local machine” under “Run on” to debug it.`,
    ),
    actions: [
      { label: "Run", run: () => void executeAction("run.runConfig", config.id) },
      { label: "Edit Configuration…", run: () => void executeAction("run.editConfigs", config.id) },
    ],
  });
  return true;
}

/**
 * Coverage and profiling read their results on this machine: tells so (offering
 * Run) and returns true when `config` runs in a container.
 */
export function containerExecutorBlocked(
  config: RunConfig,
  targets: readonly RunTargetValid[] = workflowSettings().runTargets,
): boolean {
  const target = targetOf(config, targets);
  if (!target || !inContainer(target)) return false;
  const where = target.name.trim() || target.id;
  notifications().notify({
    group: "run",
    level: "warning",
    key: "run.containerExecutor",
    title: "Coverage and profiling are not supported in containers",
    body: txTemplate(
      `'${config.name}' runs in a container on ${where}. Run it, or choose “Local machine” under “Run on”.`,
    ),
    actions: [
      { label: "Run", run: () => void executeAction("run.runConfig", config.id) },
      { label: "Edit Configuration…", run: () => void executeAction("run.editConfigs", config.id) },
    ],
  });
  return true;
}

export type StartRemedy = "trustHost" | "sshSecret" | null;

/** What a failed remote `runStart` needs from the user. */
export function startRemedy(message: string): StartRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHost";
  if (/^SSH (password|key passphrase) required|passphrase required|^cannot decrypt SSH key/.test(message))
    return "sshSecret";
  return null;
}

export interface RemedyDeps {
  confirmTrust: (message: string) => Promise<boolean>;
  askSecret: (message: string, save: boolean) => Promise<{ secret: string; save: boolean } | null>;
  trustHost: (sshConfig: string) => Promise<unknown>;
  setSecret: (sshConfig: string, secret: string, save: boolean) => Promise<unknown>;
  targets: () => readonly RunTargetValid[];
  sshConfigs: () => readonly SshConfigValid[];
}

const defaultDeps: RemedyDeps = {
  confirmTrust: (message) =>
    confirm({
      title: "Unknown SSH Host",
      icon: "warning",
      message: `${message}. ${tx("The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?")}`,
      ok: "Trust and Connect",
    }),
  askSecret: (message, save) => promptSecret(message, save),
  trustHost: (id) => call(commands.sshTrustHost(id)),
  setSecret: (id, secret, save) => commands.sshSetSecret(id, secret, save),
  targets: () => workflowSettings().runTargets,
  sshConfigs: () => workflowSettings().ssh.configs,
};

/**
 * Starts a configuration through `start`; when it runs on a target and the SSH
 * connection needs a host key trusted or a secret, asks for it and retries
 * (each remedy at most once). Other errors, and declined remedies, rethrow.
 */
export async function startWithRemedies<T>(
  config: Pick<RunConfig, "target">,
  start: () => Promise<T>,
  deps: RemedyDeps = defaultDeps,
): Promise<T> {
  const used = new Set<StartRemedy>();
  for (;;) {
    try {
      return await start();
    } catch (e) {
      if (!config.target || !(e instanceof IpcError)) throw e;
      const remedy = startRemedy(e.message);
      const sshConfig = targetOf(config, deps.targets())?.sshConfig;
      if (!remedy || used.has(remedy) || !sshConfig) throw e;
      used.add(remedy);
      if (remedy === "trustHost") {
        if (!(await deps.confirmTrust(e.message))) throw e;
        await deps.trustHost(sshConfig);
      } else {
        const saved = deps.sshConfigs().find((c) => c.id === sshConfig)?.saveSecret ?? false;
        const answer = await deps.askSecret(e.message, saved);
        if (!answer) throw e;
        await deps.setSecret(sshConfig, answer.secret, answer.save);
      }
    }
  }
}
