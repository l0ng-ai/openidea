/**
 * The notice above a file that has unresolved merge conflicts, as IntelliJ shows it
 * ("File has unresolved merge conflicts" with Resolve conflicts…). It follows Git's own
 * record of the conflict, so it appears whatever the file's text holds and whether or not
 * a merge, rebase or stash is still in progress.
 */
import { registerEditorBanner } from "@/workbench/contributions";
import { openMergeEditor } from "./conflictsUi";
import { effectiveKind, stripSlash } from "./model";
import { useVcs } from "./store";

export function activate(): () => void {
  return registerEditorBanner({
    id: "vcs.conflict",
    order: -5,
    useBanner: (path) => {
      const conflicted = useVcs((s) => {
        const file = s.byPath.get(stripSlash(path));
        return !!file && effectiveKind(file) === "conflicted";
      });
      return conflicted
        ? {
            text: "File has unresolved merge conflicts",
            level: "warning",
            actions: [{ label: "Resolve conflicts…", run: () => openMergeEditor(path) }],
          }
        : null;
    },
  });
}
