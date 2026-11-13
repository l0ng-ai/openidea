/**
 * Code insight: Problems tool window, Find / Show Usages, call and
 * type hierarchies, and language server status. Editor-side LSP features live
 * in `editor/lsp`; the two talk only through actions.
 */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerMenuGroup, registerOverlay, registerStatusItem, registerToolWindow } from "@/workbench/contributions";
import { getContext } from "@/platform/context";
import { clearProblems, installProblemsEvents, useProblems } from "./problemsStore";
import { installProblemDecorations } from "./decorations";
import { ProblemsHeaderActions, ProblemsTabs, ProblemsView, useProblemsHeaderMenu } from "./ProblemsView";
import { UsagesTabs, UsagesView, useUsagesHeaderMenu } from "./UsagesView";
import { UsagesPopup } from "./UsagesPopup";
import { findUsages, rerunActiveUsages, resetUsages, showUsageResults, showUsagesPopup } from "./usages";
import { HierarchyTabs, HierarchyView } from "./HierarchyView";
import { resetHierarchy, showHierarchy } from "./hierarchy";
import { eslintCovers, installServerEvents } from "./servers";
import { ServerStatus } from "./ServerStatus";
import { reportProblems } from "./problemsReport";
import { installWorkspaceEditUndo } from "./workspaceUndo";

const EDITOR_WHEN = "textEditorActive && (editorFocus || popupOpen || !toolWindowFocus)";

function useErrorBadge(): number | null {
  return useProblems((s) => {
    let n = 0;
    for (const sources of s.map.values())
      for (const items of sources.values()) for (const d of items) if (d.severity === "error") n++;
    return n || null;
  });
}

export function activate(): () => void {
  let root = useProject.getState().project?.root ?? null;
  const unsubProject = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    if (r !== root) {
      root = r;
      clearProblems();
      resetUsages();
      resetHierarchy();
    }
  });
  const disposers = [
    unsubProject,
    installProblemsEvents(),
    reportProblems(),
    installProblemDecorations(),
    installServerEvents(),
    // WebStorm's editor popup offers Fix ESLint Problems wherever ESLint lints the file.
    registerMenuGroup({
      id: "codeInsight.eslint",
      menus: ["editor"],
      order: 40,
      items: (_menu, { paths }) =>
        paths.length === 1 && eslintCovers(paths[0]!, getContext().editorLangId as string | null)
          ? [{ kind: "action", action: "code.fixEslintProblems" }]
          : [],
    }),
    installWorkspaceEditUndo(),
    registerToolWindow({
      id: "problems",
      title: "Problems",
      icon: "toolwindow-problems",
      anchor: "bottom",
      order: 30,
      component: ProblemsView,
      headerContent: ProblemsTabs,
      headerActions: ProblemsHeaderActions,
      headerMenu: useProblemsHeaderMenu,
      useBadge: useErrorBadge,
    }),
    registerToolWindow({
      id: "usages",
      title: "Find Usages",
      icon: "toolwindow-usages",
      anchor: "bottom",
      stripe: "onUse",
      order: 35,
      component: UsagesView,
      headerContent: UsagesTabs,
      headerMenu: useUsagesHeaderMenu,
    }),
    registerToolWindow({
      id: "hierarchy",
      title: "Hierarchy",
      icon: "toolwindow-hierarchy",
      anchor: "right",
      stripe: "onUse",
      order: 40,
      component: HierarchyView,
      headerContent: HierarchyTabs,
    }),
    registerStatusItem({
      id: "code-insight.servers",
      align: "right",
      priority: 5,
      component: ServerStatus,
      title: "Language Services",
    }),
    registerOverlay({ id: "code-insight.usagesPopup", component: UsagesPopup }),
    registerActions([
      { id: "find.usages", title: "Find Usages", category: "Find", when: EDITOR_WHEN, run: () => findUsages() },
      {
        id: "find.showUsages",
        title: "Show Usages",
        category: "Find",
        when: EDITOR_WHEN,
        run: () => showUsagesPopup(),
      },
      {
        // ⌘R in the Find Usages tool window, as in IDEA.
        id: "usages.rerun",
        title: "Rerun Find Usages",
        category: "Find",
        icon: "rerun",
        when: "projectOpen && activeToolWindow == 'usages'",
        run: rerunActiveUsages,
      },
      {
        id: "find.showUsageResults",
        title: "Show Usage Results",
        category: "Find",
        hidden: true,
        description:
          "Shows `{ symbol, locations }` (found elsewhere, e.g. by Safe Delete) in the Find Usages tool window.",
        run: ({ arg }) => showUsageResults(arg),
      },
      {
        id: "navigate.callHierarchy",
        title: "Call Hierarchy",
        category: "Navigate",
        when: EDITOR_WHEN,
        run: () => showHierarchy("call"),
      },
      {
        id: "navigate.typeHierarchy",
        title: "Type Hierarchy",
        category: "Navigate",
        when: EDITOR_WHEN,
        run: () => showHierarchy("type"),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
