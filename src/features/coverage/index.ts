/**
 * Run with Coverage (IDEA's third executor beside Run and Debug): runs a
 * configuration under its runtime's coverage tool, then shows the report in
 * the Coverage tool window, as editor gutter stripes and as project tree badges.
 */
import { registerEditorContribution } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerOverlay, registerRunExecutor, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { CoverageHeaderActions, CoverageTabs, CoverageView } from "./CoverageView";
import { coverageExecutor } from "./executor";
import { coverageGutter } from "./gutter";
import { ManageReportsOverlay, closeManageReports, importReport, openManageReports } from "./reports";
import { resetCoverage, setCoverageVisible, syncCoverageViews, useCoverage } from "./store";

export function activate(): () => void {
  const disposers: Array<() => void> = [
    registerRunExecutor(coverageExecutor),
    registerToolWindow({
      id: "coverage",
      title: "Coverage",
      icon: "toolwindow-coverage",
      anchor: "right",
      stripe: "onUse",
      order: 30,
      component: CoverageView,
      headerContent: CoverageTabs,
      headerActions: CoverageHeaderActions,
    }),
    registerEditorContribution({ id: "coverage.gutter", order: 65, extensions: coverageGutter }),
    syncCoverageViews(),
    registerOverlay({ id: "coverage.manageReports", component: ManageReportsOverlay }),
    registerActions([
      {
        id: "run.coverage",
        title: "Run with Coverage",
        description: "Run the selected configuration with coverage",
        category: "Run",
        icon: "run-coverage",
        when: "projectOpen",
        keywords: ["coverage", "code coverage"],
        run: () => executeAction("run.withExecutor", { executor: "coverage" }).then(() => undefined),
      },
      {
        id: "run.coverageContext",
        title: "Run Context Configuration with Coverage",
        description: "Run the test or program in the active file with coverage",
        category: "Run",
        icon: "run-coverage",
        when: "projectOpen",
        keywords: ["coverage"],
        run: ({ arg }) =>
          executeAction("run.withExecutor", { executor: "coverage", context: arg ?? true }).then(() => undefined),
      },
      {
        id: "coverage.importReport",
        title: "Import a Coverage Report…",
        description:
          "Show a report collected elsewhere (CI): lcov, JaCoCo XML or a Go cover profile; argument: the file path",
        category: "Run",
        icon: "folder-open",
        when: "projectOpen",
        keywords: ["coverage", "lcov", "jacoco", "ci", "import"],
        run: ({ arg }) => importReport(typeof arg === "string" ? arg : undefined).then(() => undefined),
      },
      {
        id: "coverage.manageReports",
        title: "Manage Coverage Reports…",
        description: "Choose the shown coverage suite, delete suites and imported reports",
        category: "Run",
        icon: "list",
        when: "projectOpen",
        keywords: ["coverage", "suites", "show coverage data"],
        run: () => openManageReports(),
      },
      {
        id: "coverage.hide",
        title: "Hide Coverage",
        description: "Remove coverage highlighting from editors and the project view",
        category: "Run",
        icon: "close",
        when: "coverageVisible",
        run: () => setCoverageVisible(false),
      },
      {
        id: "coverage.show",
        title: "Show Coverage",
        description: "Show the selected coverage suite in editors and the project view",
        category: "Run",
        icon: "eye",
        when: "coverageSuites && !coverageVisible",
        run: () => {
          setCoverageVisible(true);
          toolWindowService().show("coverage");
        },
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) {
        resetCoverage();
        closeManageReports();
      }
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    closeManageReports();
    if (useCoverage.getState().suites.length) resetCoverage();
  };
}
