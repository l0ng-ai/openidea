/** Project-host ignore writes; shared by the project menu and Find Action. */
import type { IgnoreDestination } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { reloadAll } from "@/features/project-tree/store";
import { runOp } from "./ops";
import { refreshNow } from "./store";

export async function addToIgnore(paths: string[], destination: IgnoreDestination) {
  if (!paths.length) return;
  await runOp(
    destination === "gitignore" ? "Add to .gitignore" : "Add to .git/info/exclude",
    async () => {
      await call(commands.vcsAddToIgnore(paths, destination));
    },
    { refresh: false },
  );
  // Also refresh after a partial failure in a multi-repository selection.
  await Promise.all([refreshNow(), reloadAll()]);
}
