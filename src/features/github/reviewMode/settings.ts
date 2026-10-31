/**
 * Review mode settings: the "Review Mode" toggle, persisted per project in local storage
 * (`GithubPullRequestsProjectUISettings.editorReviewEnabled`, on by default), and the
 * threads shown while it is on ("Show Unresolved Comments Only", the default, or "Show All
 * Comments"; kept for the session like IntelliJ's view model).
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import type { EditorThreadsOption } from "./model";

interface ReviewModeSettings {
  enabled: boolean;
  threads: EditorThreadsOption;
}

const key = (root: string) => `openidea.github.reviewMode.v1:${root}`;
const projectRoot = () => useProject.getState().project?.root ?? null;

function loadEnabled(root: string | null): boolean {
  if (!root) return true;
  try {
    return globalThis.localStorage?.getItem(key(root)) !== "off";
  } catch {
    return true;
  }
}

export const useReviewModeSettings = create<ReviewModeSettings>(() => ({
  enabled: loadEnabled(projectRoot()),
  threads: "unresolved",
}));

/** Turns review mode on or off for the project. */
export function setReviewModeEnabled(enabled: boolean) {
  useReviewModeSettings.setState({ enabled });
  const root = projectRoot();
  if (!root) return;
  try {
    globalThis.localStorage?.setItem(key(root), enabled ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
}

export function setEditorThreadsOption(threads: EditorThreadsOption) {
  useReviewModeSettings.setState({ threads });
}

/** Another project: its own toggle, the default threads option. */
export function reloadReviewModeSettings() {
  useReviewModeSettings.setState({ enabled: loadEnabled(projectRoot()), threads: "unresolved" });
}
