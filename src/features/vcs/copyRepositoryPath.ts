/**
 * Copy Path/Reference… › Path From Repository Root: each path relative to the root of the
 * Git repository holding it, one per line.
 */
import { executeAction, type Action } from "@/platform/actions";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { notifications, registerMenuGroup } from "@/workbench/contributions";
import { rootOf, stripSlash } from "./model";
import { useVcs } from "./store";

/** The paths inside a repository, each from its root; null when none is. */
function repositoryPaths(paths: readonly string[]): string | null {
  const { roots } = useVcs.getState();
  const relative: string[] = [];
  for (const path of paths.map(stripSlash)) {
    // A nested repository's own root is its root, not a folder of the outer one.
    const root = roots.includes(path) ? path : rootOf(path, roots);
    if (root) relative.push(path.slice(root.length + 1) || ".");
  }
  return relative.length ? relative.join("\n") : null;
}

async function copy(text: string) {
  try {
    await writeClipboardText(text);
    void executeAction("editor.showHint", { text: tx`Copied ${text}` });
  } catch (error) {
    notifications().notify({
      level: "error",
      title: tx("Cannot access the clipboard"),
      body: error instanceof Error ? error.message : String(error),
    });
  }
}

export const copyRepositoryPathActions: Action[] = [
  {
    id: "vcs.copyRepositoryPath",
    title: "Copy Path From Repository Root",
    category: "Git",
    icon: "copy",
    when: "vcsAvailable",
    hidden: true,
    run: ({ arg }) => {
      const text = Array.isArray(arg) ? repositoryPaths(arg as string[]) : null;
      if (text) void copy(text);
    },
  },
];

export function registerCopyRepositoryPath(): () => void {
  return registerMenuGroup({
    id: "vcs.copyRepositoryPath",
    menus: ["copyPath"],
    items: (_menu, { paths }) => {
      const text = repositoryPaths(paths);
      if (!text) return [];
      return [
        {
          id: "vcs.copyRepositoryPath",
          label: "Path From Repository Root",
          preview: text,
          run: () => void executeAction("vcs.copyRepositoryPath", paths),
        },
      ];
    },
  });
}
