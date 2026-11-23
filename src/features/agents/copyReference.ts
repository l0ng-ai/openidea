/**
 * Copy Path/Reference… › Agent Reference: the clipboard text of the `@` mentions "Send to Agent"
 * writes into the composer, so a selection or a Project view file can be pasted into a terminal
 * agent as `@src/app.ts` / `@src/app.ts:12-18`.
 */
import { executeAction, type Action } from "@/platform/actions";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { notifications, registerMenuGroup } from "@/workbench/contributions";
import { mentionOf, referenceOf, type ReferenceRoots } from "./composerModel";
import { homeProjectRoot, type ReferenceTarget } from "./store";

/** The folders `@` mentions are relative to: the agent's folder and the workspace's projects. */
function referenceRoots(): ReferenceRoots {
  const project = useProject.getState().project;
  const root = homeProjectRoot() ?? "";
  return { root, projectRoot: project?.root ?? root, members: project?.workspace?.projects };
}

/** The `@` mentions of `targets`, space-separated as the composer writes them; null for none. */
export function agentReferences(targets: readonly ReferenceTarget[]): string | null {
  const roots = referenceRoots();
  const mentions = targets.map(({ path, lines }) => {
    const folder = /[\\/]$/.test(path);
    const ref = referenceOf(roots, path);
    // A folder keeps its trailing slash, so its reference reads as a folder.
    if (ref) return mentionOf(folder && ref.rel !== "." ? `${ref.rel}/` : ref.rel, lines);
    // Outside every project (Scratches): the path as written still points the agent at it.
    return mentionOf(folder ? path : path.replace(/[\\/]+$/, ""), lines);
  });
  return mentions.length ? mentions.join(" ") : null;
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

export const copyAgentReferenceActions: Action[] = [
  {
    id: "agents.copyAgentReference",
    title: "Copy Agent Reference",
    category: "Edit",
    icon: "copy",
    hidden: true,
    run: ({ arg }) => {
      const text = Array.isArray(arg) ? agentReferences(arg as ReferenceTarget[]) : null;
      if (text) void copy(text);
    },
  },
];

export function registerCopyAgentReference(): () => void {
  return registerMenuGroup({
    id: "agents.copyAgentReference",
    menus: ["copyPath"],
    items: (_menu, { paths, dirs, line, endLine }) => {
      if (!paths.length) return [];
      const targets: ReferenceTarget[] = paths.map((path, i) => ({
        path: dirs?.[i] ? `${path}/` : path,
        // A selection's 1-based range; the caret's line alone when nothing is selected.
        lines: line === undefined ? undefined : { from: line + 1, to: (endLine ?? line) + 1 },
      }));
      const text = agentReferences(targets);
      if (!text) return [];
      return [
        {
          id: "agents.copyAgentReference",
          label: "Agent Reference",
          preview: text,
          run: () => void executeAction("agents.copyAgentReference", targets),
        },
      ];
    },
  });
}
