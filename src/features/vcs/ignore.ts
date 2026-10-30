/** Project-host ignore writes; shared by the project menu and Find Action. */
import type { IgnoreDestination } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { reloadAll } from "@/features/project-tree/store";
import { editorService, notifications } from "@/workbench/contributions";
import { runOp } from "./ops";
import { refreshNow } from "./store";

export async function addToIgnore(paths: string[], destination: IgnoreDestination) {
  if (!paths.length) return;
  const changed = await runOp(
    destination === "gitignore" ? "Add to .gitignore" : "Add to .git/info/exclude",
    () => call(commands.vcsAddToIgnore(paths, destination)),
    { refresh: false },
  );
  // Also refresh after a partial failure in a multi-repository selection.
  await Promise.all([refreshNow(), reloadAll()]);
  if (changed && !changed.length) {
    // Existing rules already cover the selection (e.g. a `_*/` directory pattern).
    notifications().notify({ group: "vcs", level: "info", title: "Already ignored" });
    return;
  }
  // Show the rule where it was written: the nearest .gitignore may be a nested one.
  const file = changed?.[0];
  if (destination === "gitignore" && file) await editorService().openFile(file, { focus: true });
}
