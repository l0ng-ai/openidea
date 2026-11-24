import type { RunConfig } from "@/bindings";
import { useProject } from "@/platform/project";
import {
  toolWindowService,
  type RunConfigurationCheckResult,
  type RunConfigurationCheckService,
} from "@/workbench/contributions";
import { isCMakeBuild } from "./cmake";
import { compoundChildren } from "./configs";
import {
  closeSession,
  loadConfigs,
  prepareLaunch,
  runtime,
  startRun,
  stopSession,
  useRun,
  type RunSession,
} from "./store";
import { typeFor } from "./types";

function runnable(config: RunConfig) {
  return !isCMakeBuild(config) && !typeFor(config.kind)?.debugOnly;
}

function sessionOf(id: string) {
  return useRun.getState().sessions.find((session) => session.id === id);
}

function finished(session: RunSession | undefined) {
  return !session || session.status === "finished" || session.status === "failed";
}

function waitForFinished(id: string): Promise<RunSession | undefined> {
  const session = sessionOf(id);
  if (finished(session)) return Promise.resolve(session);
  return new Promise((resolve) => {
    const unsubscribe = useRun.subscribe(() => {
      const current = sessionOf(id);
      if (!finished(current)) return;
      unsubscribe();
      resolve(current);
    });
  });
}

function showRun(id: string) {
  if (!sessionOf(id)) return;
  useRun.setState({ activeSession: id });
  toolWindowService().show("run", true);
}

async function runSingle(
  config: RunConfig,
  signal: AbortSignal,
  chain: readonly string[],
): Promise<RunConfigurationCheckResult> {
  const name = config.name;
  if (!runnable(config)) return { name, status: "notStarted" };
  let id: string | undefined;
  const cancel = () => {
    if (!id) return;
    const session = sessionOf(id);
    if (!session?.backgroundCheck) return;
    if (session.runId === null) closeSession(id);
    else if (!finished(session) && session.status !== "stopping") void stopSession(id);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const started = await startRun(config, undefined, undefined, {
      show: false,
      chain,
      check: {
        signal,
        own: (sessionId) => {
          id = sessionId;
          if (signal.aborted) cancel();
        },
      },
    });
    signal.throwIfAborted();
    if (!started) return { name, status: "notStarted" };
    const session = await waitForFinished(started.id);
    signal.throwIfAborted();
    if (!session) return { name, status: "stopped" };
    const review = () => showRun(session.id);
    if (session.stopped) return { name, status: "stopped", review };
    if (session.status === "failed") return { name, status: "notStarted", review };
    const failedTests = runtime(session.id)?.tests?.counts().failed ?? 0;
    if (session.exitCode === 0 && failedTests === 0) {
      closeSession(session.id);
      return { name, status: "finished", exitCode: 0 };
    }
    return { name, status: "finished", exitCode: session.exitCode, failedTests, review };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted && id) {
      await waitForFinished(id);
      if (sessionOf(id)?.backgroundCheck) closeSession(id);
    }
  }
}

export async function runConfigurationToCompletion(
  config: RunConfig,
  signal: AbortSignal,
  chain: readonly string[] = [],
): Promise<RunConfigurationCheckResult[]> {
  signal.throwIfAborted();
  if (config.kind !== "compound") return [await runSingle(config, signal, chain)];
  const children = compoundChildren(config, useRun.getState().configs);
  if (!children.length || !(await prepareLaunch(config, chain, false, signal)))
    return [{ name: config.name, status: "notStarted" }];
  const results: RunConfigurationCheckResult[] = [];
  for (const child of children) {
    results.push(await runSingle(child, signal, [...chain, config.id]));
    signal.throwIfAborted();
  }
  return results;
}

let source: readonly RunConfig[] | undefined;
let options: readonly RunConfig[] = [];

export const configurationChecks: RunConfigurationCheckService = {
  configurations() {
    const { configs } = useRun.getState();
    if (configs !== source) {
      source = configs;
      options = configs.filter(runnable);
    }
    return options;
  },
  subscribe(listener) {
    return useRun.subscribe((state, previous) => {
      if (state.configs !== previous.configs) listener();
    });
  },
  async run(id, signal) {
    const project = useProject.getState().project;
    if (!project?.trusted) return [];
    if (!useRun.getState().loaded) await loadConfigs();
    signal.throwIfAborted();
    if (useProject.getState().project !== project) return [];
    const config = this.configurations().find((candidate) => candidate.id === id);
    return config ? runConfigurationToCompletion(config, signal) : [];
  },
};
