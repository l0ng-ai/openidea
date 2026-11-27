import type { RegisteredRunTarget } from "@/bindings";
import { tx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePluginRunTargets } from "@/platform/pluginRunTargets";
import { notifications } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";

let revision = 0;
const shown = new Set<string>();
function clearTargets(prompts = true) {
  revision++;
  if (prompts)
    for (const target of usePluginRunTargets.getState().targets)
      notifications().expire?.(`plugin-run-target:${target.id}`);
  shown.clear();
  usePluginRunTargets.setState({ targets: [] });
}
export async function refreshRunTargets(prompts = true) {
  const request = ++revision;
  const root = useProject.getState().project?.root;
  if (!root) {
    clearTargets(prompts);
    return;
  }
  const targets = await pluginsBackend().runTargets();
  if (request !== revision || root !== useProject.getState().project?.root) return;
  for (const previous of prompts ? usePluginRunTargets.getState().targets : []) {
    if (!targets.some((t) => t.id === previous.id && t.prompt)) {
      notifications().expire?.(`plugin-run-target:${previous.id}`);
      shown.delete(`${root}\0${previous.id}`);
    }
  }
  usePluginRunTargets.setState({ targets });
  if (!prompts) return;
  for (const target of targets) {
    const key = `${root}\0${target.id}`;
    if (!target.prompt || shown.has(key)) continue;
    shown.add(key);
    const answer = async (use: boolean) => {
      if (root !== useProject.getState().project?.root) return;
      try {
        const settings = await pluginsBackend().answerRunTarget(target.id, use);
        if (root === useProject.getState().project?.root) useProject.setState({ settings });
        await refreshRunTargets();
      } catch (error) {
        shown.delete(key);
        notifications().notify({ group: "plugins", level: "error", title: "Run Targets", body: String(error) });
      }
    };
    notifyTarget(target, answer);
  }
}
function notifyTarget(target: RegisteredRunTarget, answer: (use: boolean) => Promise<void>) {
  notifications().notify({
    sticky: true,
    group: "plugins",
    key: `plugin-run-target:${target.id}`,
    level: "info",
    title: "Run Targets",
    body: tx`Use ${target.target.name} for running PHP / Node / Composer in this project?`,
    actions: [
      { label: "Use", run: () => void answer(true) },
      { label: "Not now", run: () => void answer(false) },
    ],
  });
}
export function startRunTargets(prompts = true): () => void {
  if (isTauri()) void refreshRunTargets(prompts).catch(() => {});
  const unsubscribe = useProject.subscribe((s, old) => {
    if (s.project?.root === old.project?.root) return;
    clearTargets(prompts);
    void refreshRunTargets(prompts).catch(() => {});
  });
  return () => {
    unsubscribe();
    clearTargets(prompts);
  };
}
