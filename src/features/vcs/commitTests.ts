import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { runConfigurationChecks } from "@/workbench/contributions";
import { upsertTaskSoon } from "@/workbench/tasks";
import type { CommitCheckResult } from "./commitCheckRegistry";
import { useCommit } from "./commitStore";

interface TestSelection {
  id: string;
  name: string;
  enabled: boolean;
}

function commitTestsKey(project = useProject.getState().project, remote = useRemote.getState().session): string | null {
  if (!project?.trusted) return null;
  return `openidea.vcs.commitTests:${JSON.stringify([remote?.target ?? null, project.root])}`;
}

function readSelection(key: string): TestSelection | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as TestSelection | null;
    return value && typeof value.id === "string" && typeof value.name === "string" && typeof value.enabled === "boolean"
      ? value
      : null;
  } catch {
    return null;
  }
}

const useSelections = create<Record<string, TestSelection>>(() => ({}));

export function useCommitTestSelection() {
  const project = useProject((state) => state.project);
  const remote = useRemote((state) => state.session);
  const key = commitTestsKey(project, remote);
  const saved = useSelections((state) => (key ? state[key] : undefined));
  return saved ?? (key ? readSelection(key) : null);
}

export function commitTestSelection(): TestSelection | null {
  const key = commitTestsKey();
  return key ? (useSelections.getState()[key] ?? readSelection(key)) : null;
}

export function setCommitTestSelection(value: TestSelection) {
  const key = commitTestsKey();
  if (!key || useCommit.getState().operation) return;
  useSelections.setState({ [key]: value });
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The in-memory choice still applies in this window.
  }
  useCommit.setState({ checkResult: null });
}

let taskSeq = 0;

export async function runCommitTests(
  selection: TestSelection,
  signal?: AbortSignal,
): Promise<CommitCheckResult | null> {
  const service = runConfigurationChecks();
  if (!service) return { severity: "error", text: tx("Run configurations are unavailable.") };
  const controller = signal ? undefined : new AbortController();
  const cancel = () => controller?.abort();
  const unsubscribe = controller
    ? useProject.subscribe((state, previous) => {
        if (state.project !== previous.project) cancel();
      })
    : undefined;
  const task = {
    id: `vcs.commitTests:${++taskSeq}`,
    title: tx("Running tests for commit"),
    message: selection.name,
    fraction: null,
    cancel,
  };
  if (controller) upsertTaskSoon({ ...task, done: false });
  try {
    const results = await service.run(selection.id, signal ?? controller!.signal);
    if (!results.length) return { severity: "error", text: tx`Run configuration "${selection.name}" is unavailable.` };
    const problems = results.flatMap((result) => {
      const { name, status, exitCode, failedTests } = result;
      if (status === "notStarted") return [tx`"${name}" could not start.`];
      if (status === "stopped") return [tx`"${name}" was stopped.`];
      if (failedTests === 1) return [tx`One test failed in "${name}".`];
      if (failedTests) return [tx`${failedTests} tests failed in "${name}".`];
      if (exitCode === 0) return [];
      return [exitCode == null ? tx`"${name}" did not complete.` : tx`"${name}" exited with code ${exitCode}.`];
    });
    if (!problems.length) return null;
    const review = results.find((result) => result.review)?.review;
    return { severity: "error", text: problems.join(" "), fix: review && { label: "Review Run Output", run: review } };
  } finally {
    unsubscribe?.();
    if (controller) upsertTaskSoon({ ...task, done: true });
  }
}
