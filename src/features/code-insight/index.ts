/**
 * Code insight: Problems tool window, Find / Show Usages, call and
 * type hierarchies, and language server status. Editor-side LSP features live
 * in `editor/lsp`; the two talk only through actions.
 */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  registerAgentContextSource,
  registerMenuGroup,
  registerOverlay,
  registerStatusItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { getContext } from "@/platform/context";
import { formatMessage, tx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { showContextMenu } from "@/ui/Menu";
import { clearProblems, installProblemsEvents, problemsReport, useProblems } from "./problemsStore";
import { installProblemDecorations } from "./decorations";
import { ProblemsTabs, ProblemsView, useProblemsHeaderMenu } from "./ProblemsView";
import { UsagesTabs, UsagesView, useUsagesHeaderMenu } from "./UsagesView";
import { UsagesPopup } from "./UsagesPopup";
import {
  findUsages,
  recentUsageSearches,
  rerunActiveUsages,
  rerunRecentUsages,
  resetUsages,
  showUsageResults,
  showUsagesPopup,
} from "./usages";
import { HierarchyTabs, HierarchyView } from "./HierarchyView";
import { resetHierarchy, showHierarchy } from "./hierarchy";
import { installServerEvents, linterCovers } from "./servers";
import { ServerStatus } from "./ServerStatus";
import { reportProblems } from "./problemsReport";
import { installWorkspaceEditUndo } from "./workspaceUndo";

const EDITOR_WHEN = "textEditorActive && (editorFocus || !toolWindowFocus)";

/** Recent Find Usages: IDEA's list of the last searches; the chosen one runs again in the tool window. */
function showRecentUsages() {
  const items = recentUsageSearches().map((search) => ({
    label: search.symbol ? formatMessage(tx("Usages of '{symbol}'"), { symbol: search.symbol }) : tx("Usages"),
    verbatim: true,
    shortcut: `${basename(search.path)}:${search.line + 1}`,
    run: () => void rerunRecentUsages(search),
  }));
  showContextMenu("center", items, { title: "Recent Find Usages" });
}

function useErrorBadge(): number | null {
  return useProblems((s) => s.counts.error || null);
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
    registerAgentContextSource({
      id: "problems",
      title: "Problems",
      description: "The project's errors and warnings",
      icon: "problems",
      resolve: async () => {
        const root = useProject.getState().project?.root;
        const text = root ? problemsReport(useProblems.getState().map, root) : null;
        return text ? { kind: "block", info: "problems", text } : null;
      },
    }),
    reportProblems(),
    installProblemDecorations(),
    installServerEvents(),
    // WebStorm's editor popup offers Fix ESLint / Stylelint Problems wherever that linter lints the file.
    registerMenuGroup({
      id: "codeInsight.eslint",
      menus: ["editor"],
      order: 40,
      items: (_menu, { paths }) => {
        if (paths.length !== 1) return [];
        const language = getContext().editorLangId as string | null;
        return [
          ["eslint", "code.fixEslintProblems"],
          ["stylelint", "code.fixStylelintProblems"],
        ]
          .filter(([server]) => linterCovers(server!, paths[0]!, language))
          .map(([, action]) => ({ kind: "action" as const, action: action! }));
      },
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
      headerMenu: useProblemsHeaderMenu,
      useBadge: useErrorBadge,
    }),
    registerToolWindow({
      id: "usages",
      title: "Find Usages",
      icon: "toolwindow-usages",
      anchor: "bottom",
      stripe: "onUse",
      sessionContent: true,
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
        id: "find.recentUsages",
        title: "Recent Find Usages",
        category: "Find",
        when: "projectOpen",
        enabled: () => recentUsageSearches().length > 0,
        run: showRecentUsages,
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
