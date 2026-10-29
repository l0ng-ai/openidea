/**
 * Maven / Gradle tool window state: the build model of the open project (static
 * parse + cached sync, from `build_model`), background syncs (`build_sync`,
 * shown as cancellable background tasks), the toolbar toggles and profile
 * choices (per project, in localStorage) and running goals through the run
 * feature's actions.
 */
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
import { useProject } from "@/platform/project";
import { editorService, notifications } from "@/workbench/contributions";
import { cancelTask, removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { profilesList, type GradleRunOptions, type MavenRunOptions } from "./model";

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
  /** Project selected in each tree (Maven `pom`, Gradle path): where Execute Goal runs. */
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

export function setProfile(id: string, checked: boolean) {
  updateSettings((s) => ({ ...s, maven: { ...s.maven, profiles: { ...s.maven.profiles, [id]: checked } } }));
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
  if (!root || !isTauri()) return;
  useBuild.setState({ loading: true });
  try {
    const [model, configs] = await Promise.all([
      call(commands.buildModel()),
      call(commands.runConfigs()).catch(() => [] as RunConfig[]),
    ]);
    if (gen !== generation) return;
    useBuild.setState({ model, configs, loading: false, error: null });
  } catch (e) {
    if (gen === generation) useBuild.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Tree keys expanded on first show: the top-level projects. */
export function initialExpanded(tool: BuildTool, model: BuildModel): Set<string> {
  if (tool === "maven")
    return new Set(model.maven?.projects.filter((p) => !p.aggregated).map((p) => `mvn:${p.pom}`) ?? []);
  return new Set(model.gradle ? ["gradle::"] : []);
}

const TITLES: Record<BuildTool, string> = { maven: "Syncing Maven projects", gradle: "Syncing Gradle projects" };

/** Reloads all projects of `tool` from the build tool itself (effective POM, dependency tree, task list). */
export async function syncTool(tool: BuildTool): Promise<void> {
  const state = useBuild.getState();
  const root = state.root;
  if (!root || !isTauri() || state.syncing[tool]) return;
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
    const next = await call(commands.buildSync(tool, request, offline, profiles, channel));
    if (useBuild.getState().root !== root) return;
    const configs = await call(commands.runConfigs()).catch(() => useBuild.getState().configs);
    useBuild.setState({ model: next, configs });
    const error = tool === "maven" ? next.maven?.syncError : next.gradle?.syncError;
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
    if (useBuild.getState().syncing[tool]?.request === request) setSync(undefined);
    upsertTask({ id: taskId, title: TITLES[tool], message: null, fraction: 1, done: true });
  }
}

export function cancelSync(tool: BuildTool) {
  const s = useBuild.getState().syncing[tool];
  if (!s) return;
  const taskId = `build-sync:${tool}`;
  if (useTasks.getState().tasks.some((t) => t.id === taskId && t.cancel)) cancelTask(taskId);
  else void commands.cancelRequest(s.request);
}

export function resetBuild() {
  generation++;
  useAnalyzer.setState({ pom: null });
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

/** Module the Dependency Analyzer shows (`pom`, project-relative); `null` = the first one. */
export const useAnalyzer = create<{ pom: string | null }>(() => ({ pom: null }));

/** Opens (or focuses) the Dependency Analyzer tab, showing the module `pom` when given. */
export async function openAnalyzer(pom: string | null) {
  if (pom) useAnalyzer.setState({ pom });
  await editorService().openInput({ kind: ANALYZER_KIND, key: ANALYZER_KIND, data: {} }, { focus: true });
}
