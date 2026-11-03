/**
 * Build menu (Build Project ⌘F9, Build Module ⇧⌘F9, Rebuild Project, Build
 * Artifacts) and the Build tool window. The backend picks the build system of
 * the project or module: Maven, Gradle, Cargo, Go or TypeScript.
 */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  maybeEditorService,
  registerMenuGroup,
  registerTitleItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { BuildTitleItem } from "./BuildTitleItem";
import { BuildHeaderActions, BuildView } from "./BuildView";
import { BUILD_RUNNING, resetBuildRun, startBuild, stopBuild, useBuildRun } from "./store";

const WHEN = `projectOpen && !${BUILD_RUNNING}`;

/** The module to build: the invoker's path (project view) or the active editor's file. */
function moduleTarget(arg: unknown): string | null {
  if (typeof arg === "string" && arg) return arg;
  return maybeEditorService()?.activePath() ?? null;
}

function useErrorBadge(): number | null {
  return useBuildRun((s) =>
    s.status === "failed" ? s.messages.filter((m) => m.severity === "error").length || null : null,
  );
}

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: "build",
      title: "Build",
      icon: "toolwindow-build",
      anchor: "bottom",
      stripe: "onUse",
      order: 6,
      component: BuildView,
      headerActions: BuildHeaderActions,
      useBadge: useErrorBadge,
    }),
    registerTitleItem({
      id: "build.project",
      title: "Build Project",
      align: "right",
      priority: -1,
      component: BuildTitleItem,
    }),
    registerActions([
      {
        id: "build.buildProject",
        title: "Build Project",
        description: "Compiles the project's sources and tests with its build system",
        category: "Build",
        icon: "build-project",
        when: WHEN,
        keywords: ["compile", "make", "mvn", "gradle", "cargo", "tsc", "go build"],
        // Awaitable: Run's "Build" before launch task waits for the result.
        run: async ({ arg }) => {
          const activate = !(typeof arg === "object" && arg !== null && "activate" in arg && arg.activate === false);
          await startBuild("build", null, activate);
        },
      },
      {
        id: "build.buildModule",
        title: "Build Module",
        description: "Compiles the module of the current file",
        category: "Build",
        when: WHEN,
        keywords: ["recompile", "compile file", "make module"],
        run: ({ arg }) => {
          const target = moduleTarget(arg);
          void startBuild("build", target);
        },
      },
      {
        id: "build.rebuildProject",
        title: "Rebuild Project",
        description: "Cleans the build outputs, then builds the project",
        category: "Build",
        icon: "build-rebuild",
        when: WHEN,
        keywords: ["clean", "compile"],
        run: () => void startBuild("rebuild"),
      },
      {
        id: "build.buildArtifacts",
        title: "Build Artifacts",
        description: "Packages the project (mvn package, gradle assemble, cargo build --release, npm run build)",
        category: "Build",
        when: WHEN,
        keywords: ["package", "assemble", "jar", "release"],
        run: () => void startBuild("artifacts"),
      },
      {
        id: "build.stop",
        title: "Stop Build",
        category: "Build",
        icon: "stop",
        when: BUILD_RUNNING,
        run: () => stopBuild(),
      },
    ]),
    registerMenuGroup({
      id: "build.module",
      menus: ["projectView"],
      order: 40,
      items: (_menu, ctx) =>
        ctx.paths.length === 1 && useProject.getState().project
          ? [{ kind: "action", action: "build.buildModule", arg: ctx.paths[0] }]
          : [],
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetBuildRun();
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    resetBuildRun();
  };
}
