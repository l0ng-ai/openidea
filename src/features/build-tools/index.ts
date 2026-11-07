/**
 * Maven and Gradle tool windows (right stripe), registered only while the open
 * project has that build system, like IDEA. The model is re-read when build
 * files change; running goals / tasks goes through the run feature's actions.
 */
import { onEditorEvent, registerEditorContribution } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { onIdeEvent, type BuildModel, type BuildTool } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerRunAnythingProvider,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { lazyComponent } from "@/ui";
import { GradleView, MavenView } from "./BuildToolView";
import { ExecutePopupHost } from "./ExecutePopup";
import { pomNavigationExtension } from "./pomNavigation";
import { buildToolsRunAnything } from "./runAnything";
import { versionCatalogExtension } from "./versionCatalog";
import { expandableKeys, gradleChildren, gradleRoots, mavenChildren, mavenRoots, gradleProjectKey } from "./model";
import {
  ANALYZER_KIND,
  addProjects,
  linkGradleProjects,
  unlinkGradleProjects,
  requestSync,
  unlinkProjects,
  cancelSync,
  loadModel,
  changedOutsideIde,
  noteExternalBuildChange,
  noteIdeSave,
  openAnalyzer,
  resetBuild,
  setExpanded,
  setCurrentProject,
  syncTool,
  toggleGradleOffline,
  toggleMavenOffline,
  toggleSkipTests,
  useBuild,
} from "./store";

export const MAVEN_WHEN = "projectOpen && build.maven";
export const GRADLE_WHEN = "projectOpen && build.gradle";

/** Build files whose creation / change / removal re-reads the model. */
const BUILD_FILE =
  /(?:^|\/)(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|mvnw(?:\.cmd)?|gradlew(?:\.bat)?|gradle\.properties|gradle-wrapper\.properties|[^/]+\.versions\.toml)$/;

function expandAll(tool: BuildTool) {
  const { model, configs } = useBuild.getState();
  if (tool === "maven" && model?.maven) {
    const m = model.maven;
    setExpanded(
      tool,
      expandableKeys(mavenRoots(m), (n) => mavenChildren(n, m, configs)),
    );
  } else if (tool === "gradle" && model?.gradle?.length) {
    const g = model.gradle;
    setExpanded(
      tool,
      expandableKeys(gradleRoots(g), (n) => gradleChildren(n, g, configs)),
    );
  }
}

function openExecute(tool: BuildTool) {
  useBuild.setState({ executeOpen: tool });
}

/** Project-relative `pom` of a Maven project from an action argument: `{ pom }`, or `{ path }` of a pom.xml. */
function analyzerPom(arg: unknown): string | null {
  const { model, root, current } = useBuild.getState();
  const projects = model?.maven?.projects ?? [];
  const a = (arg ?? {}) as { pom?: unknown; path?: unknown };
  if (typeof a.pom === "string") return a.pom;
  if (typeof a.path === "string" && root) {
    const rel = a.path.startsWith(`${root}/`) ? a.path.slice(root.length + 1) : a.path;
    if (projects.some((p) => p.pom === rel)) return rel;
  }
  return current.maven ?? null;
}

/** The analyzer module of a Gradle project from an action argument: `{ gradlePath }`, or `{ path }` of its build script. */
function analyzerGradle(arg: unknown): string | null {
  const { model, root } = useBuild.getState();
  const a = (arg ?? {}) as { buildDir?: unknown; gradlePath?: unknown; path?: unknown };
  for (const build of model?.gradle ?? []) {
    const project = build.projects.find((p) => {
      if (typeof a.gradlePath === "string")
        return p.path === a.gradlePath && (a.buildDir === undefined || a.buildDir === build.dir);
      const file = p.buildFile;
      return (
        typeof a.path === "string" &&
        root &&
        file &&
        (/^(?:[A-Za-z]:[\\/]|\/)/.test(file) ? file : `${root}/${file}`) === a.path
      );
    });
    if (project) return gradleProjectKey(build, project);
  }
  return null;
}

const synced = new Set<string>();

/** Registers / unregisters the tool windows to match the model; first sync of a never-synced build. */
function apply(model: BuildModel | null, registered: Partial<Record<BuildTool, () => void>>) {
  const has: Record<BuildTool, boolean> = { maven: !!model?.maven, gradle: !!model?.gradle?.length };
  setContext("build.maven", has.maven);
  setContext("build.gradle", has.gradle);
  for (const tool of ["maven", "gradle"] as const) {
    const visible = has[tool] || (tool === "gradle" && model !== null && !!registered.gradle);
    if (visible && !registered[tool]) {
      registered[tool] =
        tool === "maven"
          ? registerToolWindow({
              id: "maven",
              title: "Maven",
              icon: "toolwindow-maven",
              anchor: "right",
              order: 10,
              component: MavenView,
            })
          : registerToolWindow({
              id: "gradle",
              title: "Gradle",
              icon: "toolwindow-gradle",
              anchor: "right",
              order: 11,
              component: GradleView,
            });
    } else if (!visible && registered[tool]) {
      registered[tool]!();
      delete registered[tool];
    }
  }
  // Import each independent build once; linking another build must not be hidden by the first sync.
  const root = useBuild.getState().root;
  const mavenKey = `maven:${root}`;
  if (model?.maven?.projects.length && model.maven.syncedAt == null && !synced.has(mavenKey)) {
    synced.add(mavenKey);
    requestSync("maven");
  }
  for (const build of model?.gradle ?? []) {
    const key = JSON.stringify([root, build.dir]);
    if (build.syncedAt == null && !synced.has(key)) {
      synced.add(key);
      requestSync("gradle", build.dir);
    }
  }
}

export function activate(): () => void {
  const registered: Partial<Record<BuildTool, () => void>> = {};
  const showGradle = () => {
    registered.gradle ??= registerToolWindow({
      id: "gradle",
      title: "Gradle",
      icon: "toolwindow-gradle",
      anchor: "right",
      order: 11,
      component: GradleView,
    });
    toolWindowService().show("gradle", true);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLoad = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadModel(), 300);
  };
  const disposers: Array<() => void> = [
    registerOverlay({ id: "build-tools.execute", component: ExecutePopupHost }),
    registerEditorContribution({ id: "build-tools.versionCatalog", extensions: versionCatalogExtension }),
    registerEditorContribution({ id: "build-tools.pomNavigation", extensions: pomNavigationExtension }),
    registerRunAnythingProvider(buildToolsRunAnything),
    registerEditorKind({
      kind: ANALYZER_KIND,
      component: lazyComponent(() => import("./DependencyAnalyzer").then((m) => m.DependencyAnalyzer)),
      title: () => "Dependency Analyzer",
      icon: () => "build-dependencies",
      restorable: true,
    }),
    // A Gradle build script in the editor, its tab and the project view: that project's dependencies.
    registerMenuGroup({
      id: "gradle.analyzeDependencies",
      menus: ["editor", "editorTab", "projectView"],
      order: 30,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !/\/build\.gradle(\.kts)?$/.test(path) || !analyzerGradle({ path })) return [];
        return [
          { kind: "action", action: "gradle.analyzeDependencies", arg: { path }, label: "Analyze Dependencies…" },
        ];
      },
    }),
    // pom.xml in the editor, its tab and the project view: Analyze Dependencies of that module.
    registerMenuGroup({
      id: "maven.analyzeDependencies",
      menus: ["editor", "editorTab", "projectView"],
      order: 30,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !path.endsWith("/pom.xml")) return [];
        const { model, root } = useBuild.getState();
        const pom = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
        if (!pom || !model?.maven?.projects.some((p) => p.pom === pom)) return [];
        return [{ kind: "action", action: "maven.analyzeDependencies", arg: { pom }, label: "Analyze Dependencies…" }];
      },
    }),
    useBuild.subscribe((s, prev) => {
      if (s.model !== prev.model || s.root !== prev.root) apply(s.root ? s.model : null, registered);
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root && s.project?.trusted === prev.project?.trusted) return;
      synced.clear();
      resetBuild();
      if (s.project) void loadModel();
    }),
    onEditorEvent((e) => {
      if (e.type === "docSaved" && BUILD_FILE.test(e.path)) noteIdeSave(e.path);
    }),
    onIdeEvent("fsChanged", (e) => {
      const changed = [...e.created, ...e.modified, ...e.removed].filter((p) => BUILD_FILE.test(p));
      if (!changed.length) return;
      // Changes the IDE's own saves didn't make came from outside (a VCS update, another tool),
      // also for a build file open in a tab.
      if (changedOutsideIde(changed)) noteExternalBuildChange();
      scheduleLoad();
    }),
    onIdeEvent("projectRootsChanged", scheduleLoad),
    // Project JDK / Maven home and options are applied to the model's launchers.
    onIdeEvent("settingsChanged", (e) => {
      if (e.key === "languages" || e.key.startsWith("languages.java")) scheduleLoad();
    }),
    registerActions([
      {
        id: "gradle.linkProjects",
        title: "Link Gradle Projects",
        category: "Gradle",
        icon: "plus",
        when: "projectOpen && !workspaceOpen",
        run: async () => {
          showGradle();
          await linkGradleProjects();
        },
      },
      {
        id: "gradle.unlinkProjects",
        title: "Unlink Gradle Project",
        category: "Gradle",
        hidden: true,
        when: `${GRADLE_WHEN} && !workspaceOpen`,
        run: async ({ arg }) => {
          const dir = (arg as { buildDir?: unknown } | undefined)?.buildDir;
          const root = useBuild.getState().root;
          if (await unlinkGradleProjects(typeof dir === "string" ? dir : null))
            synced.delete(JSON.stringify([root, dir]));
        },
      },
      {
        id: "maven.addProjects",
        title: "Add Maven Projects",
        category: "Maven",
        icon: "plus",
        when: "projectOpen",
        run: () => addProjects(),
      },
      {
        id: "maven.unlinkProjects",
        title: "Unlink Maven Projects",
        category: "Maven",
        hidden: true,
        when: MAVEN_WHEN,
        run: ({ arg }) => unlinkProjects(analyzerPom(arg)),
      },
      {
        id: "maven.reload",
        title: "Reload All Maven Projects",
        description: "Re-reads the effective POMs and dependency trees with Maven",
        category: "Maven",
        icon: "refresh",
        when: MAVEN_WHEN,
        keywords: ["maven", "sync", "reimport", "refresh"],
        run: () => syncTool("maven"),
      },
      {
        id: "maven.cancelReload",
        title: "Stop Reloading Maven Projects",
        category: "Maven",
        icon: "stop",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => cancelSync("maven"),
      },
      {
        id: "maven.executeGoal",
        title: "Execute Maven Goal…",
        category: "Maven",
        icon: "run-anything",
        when: MAVEN_WHEN,
        keywords: ["maven", "mvn", "goal", "run anything"],
        run: () => openExecute("maven"),
      },
      {
        id: "maven.analyzeDependencies",
        title: "Analyze Dependencies…",
        description: "Shows a Maven module's dependency tree, version conflicts and where each library comes from",
        category: "Maven",
        icon: "build-dependencies",
        when: MAVEN_WHEN,
        keywords: ["maven", "dependency", "dependencies", "conflict", "tree", "exclude", "analyzer"],
        run: ({ arg }) => openAnalyzer(analyzerPom(arg)),
      },
      {
        id: "maven.toggleOffline",
        title: "Toggle Offline Mode",
        description: "Runs Maven with -o",
        category: "Maven",
        icon: "build-offline",
        when: MAVEN_WHEN,
        keywords: ["maven", "offline"],
        toggled: () => useBuild.getState().settings.maven.offline,
        run: () => toggleMavenOffline(),
      },
      {
        id: "maven.toggleSkipTests",
        title: "Toggle 'Skip Tests' Mode",
        description: "Runs Maven with -DskipTests",
        category: "Maven",
        icon: "skip-tests",
        when: MAVEN_WHEN,
        keywords: ["maven", "skip tests"],
        toggled: () => useBuild.getState().settings.maven.skipTests,
        run: () => toggleSkipTests(),
      },
      {
        id: "maven.expandAll",
        title: "Expand All",
        category: "Maven",
        icon: "expand-all",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => expandAll("maven"),
      },
      {
        id: "maven.collapseAll",
        title: "Collapse All",
        category: "Maven",
        icon: "collapse-all",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => setExpanded("maven", new Set()),
      },
      {
        id: "maven.settings",
        title: "Maven Settings…",
        description: "Opens Settings › Build, Execution, Deployment › Maven",
        category: "Maven",
        icon: "settings",
        when: MAVEN_WHEN,
        keywords: ["maven home", "mvn", "settings", "preferences"],
        run: () => void executeAction("file.settings", "build.maven"),
      },
      {
        id: "gradle.reload",
        title: "Reload All Gradle Projects",
        description: "Re-reads the task list with Gradle",
        category: "Gradle",
        icon: "refresh",
        when: GRADLE_WHEN,
        keywords: ["gradle", "sync", "refresh"],
        run: ({ arg }) => {
          const dir = (arg as { buildDir?: unknown } | undefined)?.buildDir;
          requestSync("gradle", typeof dir === "string" ? dir : null);
        },
      },
      {
        id: "gradle.analyzeDependencies",
        title: "Analyze Dependencies…",
        description:
          "Shows a Gradle project's resolved dependencies per configuration, version conflicts and where each library comes from",
        category: "Gradle",
        icon: "build-dependencies",
        when: GRADLE_WHEN,
        keywords: ["gradle", "dependency", "dependencies", "conflict", "tree", "configuration", "analyzer"],
        run: ({ arg }) => openAnalyzer(analyzerGradle(arg)),
      },
      {
        id: "gradle.cancelReload",
        title: "Stop Reloading Gradle Projects",
        category: "Gradle",
        icon: "stop",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => cancelSync("gradle"),
      },
      {
        id: "gradle.executeTask",
        title: "Execute Gradle Task…",
        category: "Gradle",
        icon: "run-anything",
        when: GRADLE_WHEN,
        keywords: ["gradle", "task", "run anything"],
        run: ({ arg }) => {
          const key = (arg as { projectKey?: unknown } | undefined)?.projectKey;
          if (typeof key === "string") setCurrentProject("gradle", key);
          openExecute("gradle");
        },
      },
      {
        id: "gradle.toggleOffline",
        title: "Toggle Offline Mode",
        description: "Runs Gradle with --offline",
        category: "Gradle",
        icon: "build-offline",
        when: GRADLE_WHEN,
        keywords: ["gradle", "offline"],
        toggled: () => useBuild.getState().settings.gradle.offline,
        run: () => toggleGradleOffline(),
      },
      {
        id: "gradle.expandAll",
        title: "Expand All",
        category: "Gradle",
        icon: "expand-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => expandAll("gradle"),
      },
      {
        id: "gradle.collapseAll",
        title: "Collapse All",
        category: "Gradle",
        icon: "collapse-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => setExpanded("gradle", new Set()),
      },
    ]),
  ];
  if (useProject.getState().project) void loadModel();
  return () => {
    clearTimeout(timer);
    disposers.reverse().forEach((d) => d());
    for (const d of Object.values(registered)) d?.();
    setContext("build.maven", false);
    setContext("build.gradle", false);
    synced.clear();
    resetBuild();
  };
}
