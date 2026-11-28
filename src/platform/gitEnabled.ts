/**
 * Settings › Version Control › Git › Enable Git integration. Off, the backend finds no
 * repositories and refuses the commands that start git on their own (clone, init, GitHub);
 * the frontend leaves out every Git action, tool window and menu.
 */
import { setContext } from "./context";
import { onWorkflowSettingsChange, useWorkflowSettings, workflowSettings } from "./workflowSettings";

export function gitEnabled(): boolean {
  return workflowSettings().vcs.git.enabled;
}

export function useGitEnabled(): boolean {
  return useWorkflowSettings((w) => w.vcs.git.enabled);
}

/**
 * Keeps the `gitDisabled` context key (for `when` clauses) in step with the setting.
 * Unset it reads as enabled, so a window that never installs it keeps its Git actions.
 */
export function installGitEnabledContext(): () => void {
  setContext("gitDisabled", !gitEnabled());
  const off = onWorkflowSettingsChange(
    (w) => w.vcs.git.enabled,
    (on) => setContext("gitDisabled", !on),
  );
  return () => {
    off();
    setContext("gitDisabled", false);
  };
}

/** Runs `register` while Git integration is on and disposes what it registered while it is off. */
export function whileGitEnabled(register: () => () => void): () => void {
  let dispose: (() => void) | null = null;
  const sync = (on: boolean) => {
    if (on && !dispose) dispose = register();
    else if (!on && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync(gitEnabled());
  const off = onWorkflowSettingsChange((w) => w.vcs.git.enabled, sync);
  return () => {
    off();
    dispose?.();
    dispose = null;
  };
}
