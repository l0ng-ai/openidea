/** Commands target the merge editor that opened a toolbar menu or Find Action. */
import { registerActions, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";

const COMMANDS = [
  ["applyLeft", "Apply Non-Conflicting Changes from the Left Side", "diff-apply-left"],
  ["applyAll", "Apply All Non-Conflicting Changes", "diff-apply-all"],
  ["applyRight", "Apply Non-Conflicting Changes from the Right Side", "diff-apply-right"],
  ["resolveSimple", "Resolve Simple Conflicts", "diff-magic-toolbar"],
  ["revert", "Revert Conflict Resolution", "diff-revert"],
  ["acceptYours", "Accept Yours"],
  ["acceptTheirs", "Accept Theirs"],
  ["apply", "Apply Merge Result"],
  ["cancel", "Cancel Merge"],
  ["reload", "Reload from Disk", "refresh"],
  ["compare", "Compare Contents", "diff"],
  ["settings", "Merge Settings", "settings"],
  ["autoApply", "Automatically Apply Non-Conflicting Changes"],
  ["compareYoursResult", "Yours and Result"],
  ["compareResultTheirs", "Result and Theirs"],
  ["compareYoursTheirs", "Yours and Theirs"],
  ["compareBaseYours", "Base and Yours"],
  ["compareBaseResult", "Base and Result"],
  ["compareBaseTheirs", "Base and Theirs"],
  ["accept", "Accept"],
  ["resolveUsingYours", "Resolve Using Yours"],
  ["resolveUsingTheirs", "Resolve Using Theirs"],
  ["ignore", "Ignore", "diff-remove"],
  ["resolveAutomatically", "Resolve Automatically", "diff-magic"],
  ["annotate", "Annotate with Git Blame", "changelist"],
  ["cut", "Cut"],
  ["copy", "Copy", "copy"],
  ["paste", "Paste"],
  ["selectAll", "Select All"],
  ["change", "Resolve Merge Change"],
] as const;

export type MergeCommand = (typeof COMMANDS)[number][0];

export interface MergeActionHost {
  enabled(command: MergeCommand): boolean;
  run(command: MergeCommand, arg?: unknown): void | Promise<void>;
  autoApply(): boolean;
}

let focused: MergeActionHost | null = null;

export function setFocusedMergeEditor(host: MergeActionHost | null) {
  focused = host;
  setContext("mergeEditorFocus", !!host);
  for (const [command] of COMMANDS) setContext(`merge.${command}`, host?.enabled(command) ?? false);
}

export function refreshMergeActions(host: MergeActionHost) {
  if (focused === host) setFocusedMergeEditor(host);
}

export function clearFocusedMergeEditor(host: MergeActionHost) {
  if (focused === host) setFocusedMergeEditor(null);
}

export function registerMergeActions(): () => void {
  return registerActions(
    COMMANDS.map(([command, title, icon]): Action => ({
      id: `merge.${command}`,
      title,
      icon,
      category: "Merge",
      when: `mergeEditorFocus && merge.${command}`,
      keywords: ["merge", "conflict"],
      hidden: command === "change",
      toggled: command === "autoApply" ? () => focused?.autoApply() ?? false : undefined,
      run: ({ arg }) => focused?.run(command, arg),
    })),
  );
}
