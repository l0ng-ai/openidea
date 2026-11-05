/**
 * Maven / Gradle tool window state: the build model of the open project (static
 * parse + cached sync, from `build_model`), background syncs (`build_sync`,
 * shown as cancellable background tasks), the toolbar toggles and profile
 * choices (per project, in localStorage) and running goals through the run
 * feature's actions.
 */
import { confirm } from "@/workbench/messages";
import { tx } from "@/platform/i18n";
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { executeAction } from "@/platform/actions";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type BuildModel,
  type BuildTool,
  type RequestId,
  type RunConfig,
  type SyncProgress,
} from "@/platform/ipc";
import { downloadJdkActions } from "@/platform/jdk";
import { useBuildModel } from "@/platform/buildModel";
import { useProject } from "@/platform/project";
import { editorService, notifications } from "@/workbench/contributions";
import { cancelTask, removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { gradleRoots, profilesList, type GradleRunOptions, type MavenRunOptions } from "./model";

export interface BuildSettings {
  maven: MavenRunOptions;
  gradle: GradleRunOptions;
}

export const DEFAULT_SETTINGS: BuildSettings = {
  maven: { offline: false, skipTests: false, profiles: {} },
  gradle: { offline: false },
};

interface SyncState {
  request: RequestId;
  message: string;
  fraction: number | null;
}

interface BuildState {
  /** Project the model belongs to. */
  root: string | null;
  model: BuildModel | null;
  loading: boolean;
  error: string | null;
  /** Run configurations (for the "Run Configurations" nodes). */
  configs: RunConfig[];
  syncing: Partial<Record<BuildTool, SyncState>>;
  settings: BuildSettings;
  expanded: Record<BuildTool, Set<string>>;
  /** Execute Goal / Task popup. */
  executeOpen: BuildTool | null;
  /** Project selected in each tree (Maven `pom`, Gradle build/project key): where commands run. */
  current: Partial<Record<BuildTool, string>>;
}

export const useBuild = create<BuildState>(() => ({
  root: null,
  model: null,
  loading: false,
  error: null,
  configs: [],
  syncing: {},
  settings: DEFAULT_SETTINGS,
  expanded: { maven: new Set(), gradle: new Set() },
  executeOpen: null,
  current: {},
}));

// Shared with the features that follow the build (run, Project view).
useBuild.subscribe((s) => {
  const shared = useBuildModel.getState();
  const gradleOffline = s.settings.gradle.offline;
  if (shared.root !== s.root || shared.model !== s.model || shared.gradleOffline !== gradleOffline)
    useBuildModel.setState({ root: s.root, model: s.model, gradleOffline });
});

// ---------------------------------------------------------------------------
// Settings (per project)

const SETTINGS_KEY = "openidea.buildTools:";
const HISTORY_KEY = "openidea.buildTools.history:";

export function readSettings(root: string): BuildSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY + root) ?? "null") as Partial<BuildSettings> | null;
    return {
      maven: { ...DEFAULT_SETTINGS.maven, ...raw?.maven, profiles: { ...raw?.maven?.profiles } },
      gradle: { ...DEFAULT_SETTINGS.gradle, ...raw?.gradle },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(root: string, settings: BuildSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY + root, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

export function updateSettings(patch: (s: BuildSettings) => BuildSettings) {
  const settings = patch(useBuild.getState().settings);
  useBuild.setState({ settings });
  const root = useBuild.getState().root;
  if (root) writeSettings(root, settings);
}

export const toggleMavenOffline = () =>
  updateSettings((s) => ({ ...s, maven: { ...s.maven, offline: !s.maven.offline } }));
export const toggleSkipTests = () =>
  updateSettings((s) => ({ ...s, maven: { ...s.maven, skipTests: !s.maven.skipTests } }));
export const toggleGradleOffline = () =>
  updateSettings((s) => ({ ...s, gradle: { ...s.gradle, offline: !s.gradle.offline } }));

/** Delay before reloading Maven after a profile toggle, so a few toggles in a row reload once. */
export const PROFILE_RELOAD_DELAY_MS = 800;
let profileReload: ReturnType<typeof setTimeout> | undefined;

export function setProfile(id: string, checked: boolean) {
  updateSettings((s) => ({ ...s, maven: { ...s.maven, profiles: { ...s.maven.profiles, [id]: checked } } }));
  // The Java language server and Build Project resolve the project with the profiles of the
  // last sync, so a new choice reloads it (IDEA re-imports on a profile change too).
  clearTimeout(profileReload);
  profileReload = setTimeout(() => {
    profileReload = undefined;
    requestSync("maven");
  }, PROFILE_RELOAD_DELAY_MS);
}

export function readHistory(tool: BuildTool): string[] {
  const root = useBuild.getState().root;
  try {
    const raw = JSON.parse(localStorage.getItem(`${HISTORY_KEY}${tool}:${root}`) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushHistory(tool: BuildTool, line: string) {
  const root = useBuild.getState().root;
  const next = [line, ...readHistory(tool).filter((h) => h !== line)].slice(0, 20);
  try {
    localStorage.setItem(`${HISTORY_KEY}${tool}:${root}`, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Model

let generation = 0;
let externalChange = false;

/**
 * A build file changed outside the editor (VCS update, another tool): the next model load
 * reloads a build it finds stale, IDEA's default "Reload after external changes". Edits in
 * the editor only show "Load … Changes".
 */
export function noteExternalBuildChange() {
  externalChange = true;
}

/** How long after the IDE saves a build file its file-system events still count as that save. */
const IDE_SAVE_WINDOW_MS = 5000;
/** Build files the IDE saved, with when: their file-system events are edits made in the IDE. */
const savedByIde = new Map<string, number>();

/** The IDE saved `path` (an editor save, not a tool rewriting it). */
export function noteIdeSave(path: string, now = Date.now()) {
  savedByIde.set(path, now);
}

/**
 * Whether any of the changed build files was written by something other than the IDE's own
 * save: a VCS update or a tool, also when the file is open in an editor tab.
 */
export function changedOutsideIde(paths: readonly string[], now = Date.now()): boolean {
  let external = false;
  for (const path of paths) {
    const at = savedByIde.get(path);
    if (at !== undefined && now - at <= IDE_SAVE_WINDOW_MS) continue;
    savedByIde.delete(path);
    external = true;
  }
  return external;
}

/** Re-reads the build model (and the run configurations) of the open project. */
export async function loadModel(): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  const gen = ++generation;
  if (root !== useBuild.getState().root) {
    useBuild.setState({
      root,
      model: null,
      configs: [],
      error: null,
      settings: root ? readSettings(root) : DEFAULT_SETTINGS,
      expanded: { maven: new Set(), gradle: new Set() },
      current: {},
    });
  }
  if (!root || useProject.getState().project?.trusted === false || !isTauri()) return;
  useBuild.setState({ loading: true });
  try {
    const [model, configs] = await Promise.all([
      call(commands.buildModel()),
      call(commands.runConfigs()).catch(() => [] as RunConfig[]),
    ]);
    if (gen !== generation) return;
    useBuild.setState({ model, configs, loading: false, error: null });
    if (externalChange) {
      externalChange = false;
      const maven = model.maven;
      if (maven?.stale && maven.syncedAt !== null && !useBuild.getState().syncing.maven) void syncTool("maven");
    }
  } catch (e) {
    if (gen === generation) useBuild.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

const UNLINKED_PROJECTS = "languages.java.maven.unlinkedProjects";

async function setLinked(root: string, pom: string, linked: boolean) {
  if (useProject.getState().project?.root !== root) return;
  const settings = await commands.settingsGet();
  if (useProject.getState().project?.root !== root) return;
  const previous = settings.languages.java?.maven?.unlinkedProjects ?? [];
  const next = linked ? previous.filter((p) => p !== pom) : [...new Set([...previous, pom])];
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  await call(commands.settingsSet("project", UNLINKED_PROJECTS, JSON.stringify(next)));
  await loadModel();
}

export async function unlinkProjects(pom: string | null) {
  const { root, model } = useBuild.getState();
  const project = model?.maven?.projects.find((p) => p.pom === pom);
  if (!root || !pom || !project) return;
  if (
    !(await confirm({
      title: "Unlink Maven projects?",
      message: project.aggregated
        ? "Remove this module and its submodules from Maven? The Java language server stops importing them, so they no longer use memory. Files will remain in the Project view; add the pom.xml again to restore them."
        : "Remove this project and its modules from Maven? Files will remain in the Project view.",
      ok: "Unlink",
    }))
  )
    return;
  cancelSync("maven");
  await setLinked(root, pom, false);
}

export async function addProjects() {
  const root = useProject.getState().project?.root;
  if (!root || !isTauri()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: tx`Add Maven Projects`,
    directory: false,
    multiple: false,
    defaultPath: root,
    filters: [{ name: "pom.xml", extensions: ["xml"] }],
  });
  if (typeof picked !== "string") return;
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  const path = picked.replace(/\\/g, "/");
  if (!path.startsWith(`${base}/`)) return;
  const pom = path.slice(base.length + 1);
  if (pom.split("/").some((part) => part === ".." || part === ".") || pom.split("/").pop() !== "pom.xml") return;
  await setLinked(root, pom, true);
}

/** Links independent Gradle builds without changing their files or build scripts. */
export async function linkGradleProjects() {
  const gen = generation;
  const root = useProject.getState().project?.root;
  if (
    !root ||
    useProject.getState().project?.workspace ||
    useProject.getState().project?.trusted === false ||
    !isTauri()
  )
    return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: tx`Link Gradle Projects`,
    directory: false,
    multiple: true,
    defaultPath: root,
    filters: [{ name: "Gradle build files", extensions: ["gradle", "kts"] }],
  });
  const paths = typeof picked === "string" ? [picked] : picked;
  if (!paths?.length || useProject.getState().project?.root !== root || gen !== generation) return;
  const model = await call(commands.gradleLinkProjects(paths));
  if (useProject.getState().project?.root !== root || gen !== generation) return;
  const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
  if (useProject.getState().project?.root === root && gen === generation)
    useBuild.setState((s) => ({
      model,
      configs,
      expanded: {
        ...s.expanded,
        gradle: new Set([...s.expanded.gradle, ...initialExpanded("gradle", model)]),
      },
    }));
}

export async function unlinkGradleProjects(buildDir: string | null) {
  const expectedGeneration = generation;
  const { root, model } = useBuild.getState();
  const build = model?.gradle?.find((g) => g.dir === buildDir);
  if (
    !root ||
    useProject.getState().project?.workspace ||
    !build ||
    !(await confirm({
      title: "Unlink Gradle project?",
      message:
        "Remove this build from Gradle? Files will remain in the Project view; link its build file again to restore it.",
      ok: "Unlink",
    }))
  )
    return;
  if (useProject.getState().project?.root !== root || expectedGeneration !== generation) return;
  const gen = ++generation;
  queuedSyncs.delete("gradle");
  cancelSync("gradle");
  const next = await call(commands.gradleUnlinkProjects([build.dir]));
  if (useProject.getState().project?.root !== root || gen !== generation) return;
  const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
  if (useProject.getState().project?.root !== root || gen !== generation) return;
  useBuild.setState({ model: next, configs, current: { ...useBuild.getState().current, gradle: undefined } });
  return true;
}

/** Tree keys expanded on first show: the top-level projects. */
export function initialExpanded(tool: BuildTool, model: BuildModel): Set<string> {
  if (tool === "maven")
    return new Set(model.maven?.projects.filter((p) => !p.aggregated).map((p) => `mvn:${p.pom}`) ?? []);
  return new Set(gradleRoots(model.gradle ?? []).map((n) => n.key));
}

const TITLES: Record<BuildTool, string> = { maven: "Syncing Maven projects", gradle: "Syncing Gradle projects" };

/** Tools to sync again once their running sync ends: its options changed meanwhile. */
const queuedSyncs = new Map<BuildTool, Set<string | null>>();

/** Syncs `tool` now, or right after the sync in progress (which used the previous options). */
export function requestSync(tool: BuildTool, buildDir: string | null = null) {
  if (useBuild.getState().syncing[tool]) {
    const queued = queuedSyncs.get(tool) ?? new Set<string | null>();
    queued.add(buildDir);
    queuedSyncs.set(tool, queued);
  } else void syncTool(tool, buildDir);
}

/** Reloads the build tool model; `buildDir` limits a Gradle reload to one linked build. */
export async function syncTool(tool: BuildTool, buildDir: string | null = null): Promise<void> {
  const state = useBuild.getState();
  const gen = generation;
  const root = state.root;
  if (!root || useProject.getState().project?.trusted === false || !isTauri() || state.syncing[tool]) return;
  const request = nextRequestId();
  const taskId = `build-sync:${tool}`;
  const cancel = () => void commands.cancelRequest(request);
  const setSync = (s: SyncState | undefined) => useBuild.setState((st) => ({ syncing: { ...st.syncing, [tool]: s } }));
  setSync({ request, message: TITLES[tool], fraction: null });
  upsertTask({ id: taskId, title: TITLES[tool], message: null, fraction: null, done: false, cancel });
  const channel = new Channel<SyncProgress>();
  channel.onmessage = (p) => {
    if (useBuild.getState().syncing[tool]?.request !== request) return;
    setSync({ request, message: p.message, fraction: p.fraction });
    upsertTask({ id: taskId, title: TITLES[tool], message: p.message, fraction: p.fraction, done: false, cancel });
  };
  const { settings, model } = state;
  const profiles = tool === "maven" && model?.maven ? profilesList(model.maven.profiles, settings.maven.profiles) : [];
  const offline = tool === "maven" ? settings.maven.offline : settings.gradle.offline;
  try {
    const next = await call(commands.buildSync(tool, request, offline, profiles, buildDir, channel));
    if (useBuild.getState().root !== root || gen !== generation) return;
    const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
    if (useBuild.getState().root !== root || gen !== generation) return;
    useBuild.setState({ model: next, configs });
    const error =
      tool === "maven"
        ? next.maven?.syncError
        : (next.gradle ?? [])
            .map((g) => g.syncError)
            .filter(Boolean)
            .join("\n");
    if (error)
      notifications().notify({
        group: "run",
        level: "warning",
        title: tool === "maven" ? "Maven sync finished with errors" : "Gradle sync failed",
        body: error,
        key: `build-sync-${tool}`,
        actions: downloadJdkActions(error),
      });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        group: "run",
        level: "error",
        title: tool === "maven" ? "Cannot reload Maven projects" : "Cannot reload Gradle projects",
        body: e instanceof Error ? e.message : String(e),
        key: `build-sync-${tool}`,
      });
  } finally {
    if (useBuild.getState().syncing[tool]?.request === request) {
      setSync(undefined);
      upsertTask({ id: taskId, title: TITLES[tool], message: null, fraction: 1, done: true });
      const queued = queuedSyncs.get(tool);
      const next = queued?.values().next();
      if (next && !next.done && useBuild.getState().root === root) {
        queued!.delete(next.value);
        if (!queued!.size) queuedSyncs.delete(tool);
        void syncTool(tool, next.value);
      }
    }
  }
}

export function cancelSync(tool: BuildTool) {
  queuedSyncs.delete(tool);
  const s = useBuild.getState().syncing[tool];
  if (!s) return;
  const taskId = `build-sync:${tool}`;
  if (useTasks.getState().tasks.some((t) => t.id === taskId && t.cancel)) cancelTask(taskId);
  else void commands.cancelRequest(s.request);
}

export function resetBuild() {
  generation++;
  clearTimeout(profileReload);
  profileReload = undefined;
  queuedSyncs.clear();
  useAnalyzer.setState({ module: null });
  for (const tool of ["maven", "gradle"] as const) {
    cancelSync(tool);
    removeTask(`build-sync:${tool}`);
  }
  useBuild.setState({
    root: null,
    model: null,
    configs: [],
    syncing: {},
    error: null,
    executeOpen: null,
    current: {},
    settings: DEFAULT_SETTINGS,
    expanded: { maven: new Set(), gradle: new Set() },
  });
}

// ---------------------------------------------------------------------------
// Running (through the run feature's actions)

export function runConfig(config: RunConfig, mode: "run" | "debug") {
  void executeAction(mode === "debug" ? "run.debugConfig" : "run.runConfig", { config, temporary: true });
}

export async function createRunConfig(config: RunConfig) {
  await executeAction("run.createConfig", config);
  const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
  useBuild.setState({ configs });
}

export function setExpanded(tool: BuildTool, expanded: Set<string>) {
  useBuild.setState((s) => ({ expanded: { ...s.expanded, [tool]: expanded } }));
}

export function setCurrentProject(tool: BuildTool, id: string | undefined) {
  if (useBuild.getState().current[tool] !== id) useBuild.setState((s) => ({ current: { ...s.current, [tool]: id } }));
}

// ---------------------------------------------------------------------------
// Dependency Analyzer (an editor tab)

export const ANALYZER_KIND = "maven.dependencyAnalyzer";

/**
 * Module the Dependency Analyzer shows: a Maven `pom` or a Gradle build/project key;
 * `null` = the first one.
 */
export const useAnalyzer = create<{ module: string | null }>(() => ({ module: null }));

/** Opens (or focuses) the Dependency Analyzer tab, showing `module` when given. */
export async function openAnalyzer(module: string | null) {
  if (module) useAnalyzer.setState({ module });
  await editorService().openInput({ kind: ANALYZER_KIND, key: ANALYZER_KIND, data: {} }, { focus: true });
}
