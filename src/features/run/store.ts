/**
 * Run state: configurations, the selected configuration and run sessions
 * (one Run tool window tab each). Output streams through a Channel into a
 * per-session `ConsoleModel`, batched per animation frame.
 */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import {
  call,
  commands,
  isTauri,
  type OutputChunk,
  type RunConfig,
  type RunId,
  type TestCaseReport,
} from "@/platform/ipc";
import { formatCompileErrors, isJvmApplication, parseJavaArgs, resolveJavaCommand } from "@/platform/javaLaunch";
import { downloadJdkActions } from "@/platform/jdk";
import { useProject } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { workflowSettings } from "@/platform/workflowSettings";
import { maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { ConsoleModel } from "./console";
import { jvmFrameTarget } from "./links";
import { confirmRerun, confirmTerminate } from "./dialogs";
import {
  createTestParser,
  frameworkFor,
  TestResults,
  withTestReporting,
  type TestEvent,
  type TestOutputParser,
} from "./testing";
import { recordTestStates } from "./testing/states";
import { failedTestPaths, leafTestPaths, rerunFailedConfig, testsConfig } from "./testing/rerun";
import { compoundChildren } from "./configs";
import { remoteLabel, startWithRemedies } from "./remote";
import { TerminalOutput } from "./terminalOutput";
import { typeFor } from "./types";
import { startedPort } from "./serverPort";
import { tx } from "@/platform/i18n";

/** The permanent "Current File" pseudo-configuration of the chooser (runs the active file's context). */
export const CURRENT_FILE = "current-file";

export type SessionStatus = "starting" | "running" | "finished" | "failed";

export interface RunSession {
  id: string;
  config: RunConfig;
  runId: RunId | null;
  status: SessionStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  stdinClosed: boolean;
  /** Stopped by the user; a non-zero exit code then isn't a failure. */
  stopped?: boolean;
  /** The unfiltered configuration when this run was started by "Rerun Failed Tests". */
  baseConfig?: RunConfig;
  /** "Emulate terminal in output console": the output is a terminal. */
  terminal?: boolean;
  /** The HTTP port the application's embedded web server reported it started on. */
  httpPort?: number;
}

interface SessionRuntime {
  console: ConsoleModel;
  tests: TestResults | null;
  parser: TestOutputParser | null;
  queue: OutputChunk[];
  flushHandle: number | null;
  /** Bumped per start so output from a previous run in the same tab is ignored. */
  generation: number;
  /** Called with every complete output line (e.g. waiting for a JDWP agent). */
  lineListeners: Array<(text: string) => void>;
  /** Called once the process exited (run executors: collect a coverage report…). */
  onExit?: (exitCode: number | null, stopped: boolean) => void;
  /** User input typed into the console, not yet sent (IDEA: Enter sends the line). */
  input: string;
  /** Output of a run that emulates a terminal (instead of `console`). */
  terminal: TerminalOutput | null;
  /** Last size the terminal console reported (sent once the process has an id). */
  terminalSize: { cols: number; rows: number } | null;
}

interface RunState {
  configs: RunConfig[];
  loaded: boolean;
  loadError: string | null;
  selectedId: string | null;
  /** Ids of temporary configurations (created by gutter / context runs, not saved; last in `configs`). */
  temporary: string[];
  sessions: RunSession[];
  activeSession: string | null;
  /** Output version per session (re-render trigger for the console). */
  versions: Record<string, number>;
  chooserOpen: boolean;
  /**
   * What the chooser does with a configuration: `select` it (title bar widget), or `run` /
   * `debug` it (⌃⌥R; holding Shift swaps the executor, as IDEA).
   */
  chooserMode: "select" | "run" | "debug";
  editorOpen: boolean;
  /** Config to preselect when the edit dialog opens. */
  editTarget: string | null;
  /** The edit dialog opens with unsaved changes (a temporary configuration to make permanent on OK). */
  editDirty: boolean;
}

export const useRun = create<RunState>(() => ({
  configs: [],
  loaded: false,
  loadError: null,
  selectedId: null,
  temporary: [],
  sessions: [],
  activeSession: null,
  versions: {},
  chooserOpen: false,
  chooserMode: "select",
  editorOpen: false,
  editTarget: null,
  editDirty: false,
}));

const runtimes = new Map<string, SessionRuntime>();
let sessionSeq = 0;

export function runtime(sessionId: string): SessionRuntime | undefined {
  return runtimes.get(sessionId);
}

// ---------------------------------------------------------------------------
// Configurations

const SELECTED_KEY = "openidea.run.selected:";

function readSelected(root: string): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY + root);
  } catch {
    return null;
  }
}

function writeSelected(root: string, id: string | null) {
  try {
    if (id) localStorage.setItem(SELECTED_KEY + root, id);
    else localStorage.removeItem(SELECTED_KEY + root);
  } catch {
    /* storage unavailable */
  }
}

export async function loadConfigs(): Promise<void> {
  const root = useProject.getState().project?.root;
  if (!root) {
    useRun.setState({ configs: [], loaded: false, selectedId: null });
    return;
  }
  if (!isTauri()) {
    useRun.setState({ configs: [], loaded: true, loadError: null });
    return;
  }
  try {
    const saved = await call(commands.runConfigs());
    if (useProject.getState().project?.root !== root) return;
    // Temporary configs survive reloads (and restarts) until saved or evicted; a saved one wins.
    const temps = readTemporary(root).filter((t) => !saved.some((c) => c.id === t.id));
    const configs = [...saved, ...temps];
    const stored = useRun.getState().selectedId ?? readSelected(root);
    const selectedId =
      stored === CURRENT_FILE || configs.some((c) => c.id === stored)
        ? stored
        : (defaultSelection(saved)?.id ?? CURRENT_FILE);
    useRun.setState({ configs, temporary: temps.map((t) => t.id), loaded: true, loadError: null, selectedId });
  } catch (e) {
    useRun.setState({ loaded: true, loadError: e instanceof Error ? e.message : String(e) });
  }
}

/** IDEA picks an application config first; prefer a run/dev/start target over builds and tests. */
export function defaultSelection(configs: readonly RunConfig[]): RunConfig | undefined {
  const score = (c: RunConfig) => {
    if (c.isTest) return 1;
    if (c.kind === "spring-boot") return 4;
    const s = `${c.id} ${c.name}`.toLowerCase();
    if (/bootrun|spring-boot:run|:run\b|run:|\bdev\b|\bstart\b|\bserve\b|runserver/.test(s)) return 3;
    if (/build|package|lint|check|format|clean/.test(s)) return 0;
    return 2;
  };
  return [...configs].sort((a, b) => score(b) - score(a))[0];
}

export function selectConfig(id: string | null) {
  useRun.setState({ selectedId: id });
  const root = useProject.getState().project?.root;
  if (root) writeSelected(root, id);
}

/** Whether the chooser's "Current File" is selected. */
export function currentFileSelected(): boolean {
  return useRun.getState().selectedId === CURRENT_FILE;
}

export function selectedConfig(): RunConfig | undefined {
  const { configs, selectedId } = useRun.getState();
  return configs.find((c) => c.id === selectedId);
}

// ---------------------------------------------------------------------------
// Temporary configurations (IDEA: created by gutter / context runs, at most 5)

const TEMPORARY_KEY = "openidea.run.temporary:";
export const MAX_TEMPORARY = 5;

function readTemporary(root: string): RunConfig[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TEMPORARY_KEY + root) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter((c): c is RunConfig => !!c && typeof c === "object" && typeof (c as RunConfig).id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeTemporary(root: string, configs: RunConfig[]) {
  try {
    if (configs.length) localStorage.setItem(TEMPORARY_KEY + root, JSON.stringify(configs));
    else localStorage.removeItem(TEMPORARY_KEY + root);
  } catch {
    /* storage unavailable */
  }
}

function persistTemporary() {
  const root = useProject.getState().project?.root;
  if (!root) return;
  const { configs, temporary } = useRun.getState();
  writeTemporary(
    root,
    temporary.map((id) => configs.find((c) => c.id === id)).filter((c): c is RunConfig => !!c),
  );
}

/**
 * Selects the configuration for a gutter / context run: a saved or detected
 * configuration with the same id is reused, otherwise `config` becomes a
 * temporary one (the oldest idle temporary is dropped beyond five).
 */
export function adoptTemporary(config: RunConfig): RunConfig {
  const state = useRun.getState();
  const existing = state.configs.find((c) => c.id === config.id);
  if (existing && !state.temporary.includes(config.id)) {
    selectConfig(existing.id);
    return existing;
  }
  let temporary = [...state.temporary.filter((id) => id !== config.id), config.id];
  const busy = new Set(
    state.sessions.filter((x) => x.status === "running" || x.status === "starting").map((x) => x.config.id),
  );
  while (temporary.length > MAX_TEMPORARY) {
    const evict = temporary.find((id) => id !== config.id && !busy.has(id)) ?? temporary[0]!;
    temporary = temporary.filter((id) => id !== evict);
  }
  const configs = [
    ...state.configs.filter((c) => c.id !== config.id && (!state.temporary.includes(c.id) || temporary.includes(c.id))),
    config,
  ];
  useRun.setState({ configs, temporary });
  persistTemporary();
  selectConfig(config.id);
  return config;
}

/** "Save Configuration": a temporary configuration becomes a user configuration. */
export async function saveTemporary(id: string): Promise<void> {
  const { configs, temporary } = useRun.getState();
  const config = configs.find((c) => c.id === id);
  if (!config || !temporary.includes(id)) return;
  const user = configs.filter((c) => !c.detected && !temporary.includes(c.id));
  useRun.setState({ temporary: temporary.filter((t) => t !== id) });
  persistTemporary();
  await saveUserConfigs([...user, { ...config, detected: false }]);
  selectConfig(id);
}

/** Whether the chooser's Delete may remove `id` (user and temporary configurations; detected ones come back). */
export function canDeleteConfig(id: string): boolean {
  const { configs, temporary } = useRun.getState();
  const config = configs.find((c) => c.id === id);
  return !!config && (temporary.includes(id) || !config.detected);
}

/** Deletes a user or temporary configuration. */
export async function deleteConfig(id: string): Promise<void> {
  if (!canDeleteConfig(id)) return;
  const { configs, temporary, selectedId } = useRun.getState();
  if (selectedId === id) selectConfig(null);
  if (temporary.includes(id)) {
    useRun.setState({ configs: configs.filter((c) => c.id !== id), temporary: temporary.filter((t) => t !== id) });
    persistTemporary();
    return;
  }
  await saveUserConfigs(configs.filter((c) => !c.detected && !temporary.includes(c.id) && c.id !== id));
}

/** Persists user configurations and reloads the merged list. */
export async function saveUserConfigs(user: RunConfig[]): Promise<void> {
  await call(commands.runSaveConfigs(user.map((c) => ({ ...c, detected: false }))));
  await loadConfigs();
}

// ---------------------------------------------------------------------------
// Sessions

function bump(sessionId: string) {
  useRun.setState((s) => ({ versions: { ...s.versions, [sessionId]: (s.versions[sessionId] ?? 0) + 1 } }));
}

function patchSession(id: string, patch: Partial<RunSession>) {
  useRun.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

function getSession(id: string): RunSession | undefined {
  return useRun.getState().sessions.find((s) => s.id === id);
}

function flush(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) return;
  if (rt.flushHandle !== null) {
    cancelAnimationFrame(rt.flushHandle);
    rt.flushHandle = null;
  }
  if (rt.queue.length === 0) return;
  const chunks = rt.queue.splice(0);
  for (const c of chunks) rt.console.append(c);
  bump(sessionId);
}

function enqueue(sessionId: string, chunk: OutputChunk) {
  const rt = runtimes.get(sessionId);
  if (!rt) return;
  if (rt.terminal) {
    rt.terminal.append(chunk);
    return;
  }
  rt.queue.push(chunk);
  if (rt.flushHandle === null) rt.flushHandle = requestAnimationFrame(() => flush(sessionId));
}

/** Settings › Console › Override console cycle buffer size, in characters (null = line cap only). */
function consoleCharLimit(): number | null {
  const c = workflowSettings().console;
  return c.overrideBuffer ? c.bufferKb * 1024 : null;
}

/** Applies a changed cycle buffer size to every open console. */
export function applyConsoleSettings() {
  const limit = consoleCharLimit();
  for (const [id, rt] of runtimes) {
    rt.console.setMaxChars(limit);
    bump(id);
  }
}

function newRuntime(config: RunConfig): SessionRuntime {
  const tests = config.isTest ? new TestResults() : null;
  const parser = config.isTest ? createTestParser(config) : null;
  const runtime: SessionRuntime = {
    tests,
    parser,
    console: new ConsoleModel({
      maxChars: consoleCharLimit(),
      onLine: (text, kind) => {
        if (parser && tests && kind !== "system") tests.apply(parser.feed(text));
        if (kind !== "system") for (const l of runtime.lineListeners) l(text);
      },
    }),
    queue: [],
    flushHandle: null,
    generation: 0,
    lineListeners: [],
    input: "",
    terminal: null,
    terminalSize: null,
  };
  return runtime;
}

/** Runs a configuration's before launch tasks; false aborts the launch. Installed by the feature. */
export type BeforeLaunchRunner = (config: RunConfig, chain: readonly string[]) => Promise<boolean>;
let beforeLaunch: BeforeLaunchRunner | null = null;

export function setBeforeLaunchRunner(runner: BeforeLaunchRunner | null) {
  beforeLaunch = runner;
}

/** Runs `config`'s before launch tasks (none: true). `chain` holds the configurations already launching. */
export async function prepareLaunch(config: RunConfig, chain: readonly string[] = []): Promise<boolean> {
  if (!config.beforeLaunch?.length || !beforeLaunch) return true;
  return beforeLaunch(config, [...chain, config.id]);
}

/** Starts every configuration of a compound (after the compound's own before launch tasks). */
export async function startCompound(config: RunConfig, chain: readonly string[] = []): Promise<RunSession[]> {
  if (!(await prepareLaunch(config, chain))) return [];
  const children = compoundChildren(config, useRun.getState().configs);
  const sessions = await Promise.all(
    children.map((c) => startRun(c, undefined, undefined, { chain: [...chain, config.id] })),
  );
  return sessions.filter((s): s is RunSession => !!s);
}

/** Sessions of `config`: its own, or for a compound those of its configurations. */
export function sessionsOf(config: RunConfig, sessions = useRun.getState().sessions): RunSession[] {
  if (config.kind !== "compound") return sessions.filter((s) => s.config.id === config.id);
  const ids = new Set(compoundChildren(config, useRun.getState().configs).map((c) => c.id));
  return sessions.filter((s) => ids.has(s.config.id));
}

/** Starts `config`, reusing the tab of a finished (or the given) session for the same config. */
export async function startRun(
  config: RunConfig,
  reuse?: string,
  baseConfig?: RunConfig,
  options: {
    show?: boolean;
    /** Launch this instead of `config` (e.g. with a debug agent); the tab still shows `config`. Skips before launch tasks. */
    launch?: RunConfig;
    /** Every output line of this run. */
    onLine?: (text: string) => void;
    /** The process exited. */
    onExit?: (exitCode: number | null, stopped: boolean) => void;
    /** Before launch tasks already ran (or must not run). */
    prepared?: boolean;
    /** Configurations whose launch led to this one (before launch tasks, compounds): breaks cycles. */
    chain?: readonly string[];
  } = {},
): Promise<RunSession | null> {
  if (config.kind === "compound") {
    await startCompound(config, options.chain);
    return null;
  }
  // IDEA offers only Debug for Remote JVM Debug and the like: there is nothing to run.
  if (typeFor(config.kind)?.debugOnly && !options.launch) {
    notifications().notify({
      group: "run",
      level: "info",
      key: "run.debugOnly",
      title: `'${config.name}' can only be debugged`,
      body: "It attaches the debugger to a process started elsewhere.",
      actions: [{ label: "Debug", run: () => void executeAction("run.debugConfig", config.id) }],
    });
    return null;
  }
  if (!options.launch && !options.prepared && !(await prepareLaunch(config, options.chain))) return null;
  const state = useRun.getState();
  const busy = (s: RunSession) => s.status === "running" || s.status === "starting";
  let session = reuse ? state.sessions.find((s) => s.id === reuse) : undefined;
  // As in IDEA, a configuration that doesn't allow parallel
  // runs asks before stopping its running instances; rerunning a tab restarts it without asking.
  const others = config.allowParallel
    ? []
    : state.sessions.filter((s) => s.config.id === config.id && busy(s) && s.id !== session?.id);
  if (others.length) {
    if (
      workflowSettings().run.confirmRerun &&
      !(await confirmRerun(config.name, others.length + (session && busy(session) ? 1 : 0)))
    )
      return null;
    await Promise.all(others.map((s) => stopSession(s.id)));
    session ??= others[0];
  }
  const stopping = others.map((s) => s.id);
  if (session && busy(session)) {
    await stopSession(session.id);
    stopping.push(session.id);
  }
  // The new process starts once the old one is gone (it may still hold a port or a lock).
  await waitForExit(stopping);
  session ??= state.sessions.find((s) => s.config.id === config.id && !busy(s));

  try {
    await maybeEditorService()?.saveAll();
  } catch {
    /* saving is best effort */
  }

  const startedAt = Date.now();
  if (session) {
    const prev = runtimes.get(session.id);
    const rt = newRuntime(config);
    rt.generation = (prev?.generation ?? 0) + 1;
    if (prev?.flushHandle != null) cancelAnimationFrame(prev.flushHandle);
    runtimes.set(session.id, rt);
    session = {
      ...session,
      config,
      baseConfig,
      runId: null,
      status: "starting",
      exitCode: null,
      startedAt,
      endedAt: null,
      stdinClosed: false,
      stopped: false,
      httpPort: undefined,
    };
    const updated = session;
    useRun.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === updated.id ? updated : x)),
      activeSession: updated.id,
    }));
  } else {
    session = {
      id: `run${++sessionSeq}`,
      config,
      runId: null,
      status: "starting",
      exitCode: null,
      startedAt,
      endedAt: null,
      stdinClosed: false,
      baseConfig,
    };
    runtimes.set(session.id, newRuntime(config));
    const created = session;
    useRun.setState((s) => ({ sessions: [...s.sessions, created], activeSession: created.id }));
  }
  bump(session.id);
  const sessionId = session.id;
  const rt = runtimes.get(sessionId)!;
  const generation = rt.generation;
  if (options.onLine) rt.lineListeners.push(options.onLine);
  rt.lineListeners.push((line) => {
    const port = startedPort(line);
    if (port !== null && runtimes.get(sessionId)?.generation === generation && getSession(sessionId)?.httpPort !== port)
      patchSession(sessionId, { httpPort: port });
  });
  rt.onExit = options.onExit;
  try {
    if (config.focusToolWindow) toolWindowService().show("run", true);
    else if (options.show ?? config.openToolWindow ?? workflowSettings().run.showOnStart)
      toolWindowService().show("run");
  } catch {
    /* no workbench (tests) */
  }

  if (!isTauri()) {
    enqueue(sessionId, { kind: "system", text: "Running processes requires the desktop app.\n" });
    flush(sessionId);
    patchSession(sessionId, { status: "failed", endedAt: Date.now() });
    return getSession(sessionId) ?? null;
  }

  const channel = new Channel<OutputChunk>();
  channel.onmessage = (chunk) => {
    if (runtimes.get(sessionId)?.generation !== generation) return;
    enqueue(sessionId, chunk);
    if ((chunk.kind === "stdout" && config.showOnStdout) || (chunk.kind === "stderr" && config.showOnStderr))
      revealSession(sessionId);
  };
  try {
    let launch = options.launch ?? config;
    if (isJvmApplication(launch)) {
      const resolved = await resolveJvmApplication(sessionId, launch);
      if (runtimes.get(sessionId)?.generation !== generation) return getSession(sessionId) ?? null;
      if (!resolved) {
        patchSession(sessionId, { status: "failed", endedAt: Date.now() });
        return getSession(sessionId) ?? null;
      }
      launch = resolved;
    }
    const prepare = typeFor(launch.kind)?.prepareLaunch;
    if (prepare) {
      launch = await prepare(launch);
      if (runtimes.get(sessionId)?.generation !== generation) return getSession(sessionId) ?? null;
    }
    // Debug launches read the agent's output lines: never through a terminal.
    if ((options.launch || launch.isTest) && launch.emulateTerminal) launch = { ...launch, emulateTerminal: false };
    if (launch.emulateTerminal) rt.terminal = new TerminalOutput();
    patchSession(sessionId, { terminal: !!launch.emulateTerminal });
    const started = launch.isTest ? withTestReporting(launch) : launch;
    const info = await startWithRemedies(started, () => call(commands.runStart(started, channel)));
    if (runtimes.get(sessionId)?.generation !== generation) return getSession(sessionId) ?? null;
    if (info.pty && rt.terminalSize) void commands.runResize(info.id, rt.terminalSize.cols, rt.terminalSize.rows);
    // The process may already have exited (fast commands) before we got its id.
    const exited = pendingExits.get(info.id);
    // "Redirect input from": stdin is the file, the console takes no input.
    patchSession(sessionId, { runId: info.id, status: "running", stdinClosed: !!launch.stdinFile });
    if (exited !== undefined) {
      pendingExits.delete(info.id);
      finishSession(sessionId, exited);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    enqueue(sessionId, { kind: "stderr", text: tx`Error running '${config.name}': ${message}\n` });
    flush(sessionId);
    patchSession(sessionId, { status: "failed", endedAt: Date.now() });
    notifications().notify({
      group: "run",
      level: "error",
      title: `Error running '${remoteLabel(config)}'`,
      body: message,
    });
  }
  return getSession(sessionId) ?? null;
}

/** "Show console when a message is printed to stdout / stderr". */
function revealSession(sessionId: string) {
  try {
    if (useRun.getState().activeSession !== sessionId) useRun.setState({ activeSession: sessionId });
    if (!toolWindowService().isVisible("run")) toolWindowService().show("run");
  } catch {
    /* no workbench (tests) */
  }
}

const pathSeparator = () => (typeof navigator !== "undefined" && /win/i.test(navigator.platform) ? ";" : ":");

/**
 * Builds the module (jdtls workspace build) and resolves `${classpath}` and the
 * project JDK of a Java application configuration. Null (and a console message) on failure.
 */
async function resolveJvmApplication(sessionId: string, config: RunConfig): Promise<RunConfig | null> {
  const say = (text: string, kind: OutputChunk["kind"] = "system") => {
    enqueue(sessionId, { kind, text } as OutputChunk);
    flush(sessionId);
  };
  const parsed = parseJavaArgs(config.args);
  if (!parsed.mainClass) {
    say(`No main class in '${config.name}': expected java [options] -cp \${classpath} <main class> [args]\n`, "stderr");
    return null;
  }
  if (!parsed.classpath) return config;
  say(`Building and resolving the classpath of ${parsed.mainClass}…\n`);
  try {
    const info = await call(commands.javaResolveLaunch(config.cwd ?? "", parsed.classpath === "test", true));
    if (info.build === "withErrors")
      say("Build completed with errors; launching with the last compiled classes.\n", "stderr");
    if (info.build === "failed") say("Build failed; launching with the last compiled classes.\n", "stderr");
    const compileReport = formatCompileErrors(info);
    if (compileReport) say(compileReport, "stderr");
    // No installed JDK is new enough for the module: offer to download one.
    const jdkHint = info.hints.find((h) => downloadJdkActions(h).length);
    if (jdkHint)
      notifications().notify({
        group: "run",
        level: "warning",
        key: "run.jdk-missing",
        title: `No JDK can run '${config.name}'`,
        body: jdkHint,
        actions: downloadJdkActions(jdkHint),
      });
    if (!info.classPaths.length) {
      say("The classpath is empty: is the module imported by the Java language server?\n", "stderr");
      return null;
    }
    return resolveJavaCommand(config, info, pathSeparator());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    say(`Cannot resolve the classpath: ${message}\n`, "stderr");
    // jdtls can't start without a newer JDK: "Download JDK 25".
    const actions = downloadJdkActions(message);
    notifications().notify({
      group: "run",
      level: "error",
      title: `Cannot run '${config.name}'`,
      body: message,
      actions,
    });
    return null;
  }
}

/** Exit codes that arrived before `runStart` resolved (keyed by run id). */
const pendingExits = new Map<RunId, number | null>();

function finishSession(sessionId: string, code: number | null) {
  const rt = runtimes.get(sessionId);
  const session = getSession(sessionId);
  if (!rt || !session) return;
  // Output still on the channel lands before the exit is applied.
  setTimeout(() => {
    void (async () => {
      if (runtimes.get(sessionId) !== rt) return;
      flush(sessionId);
      rt.console.flush();
      if (rt.tests && rt.parser) {
        rt.tests.apply(rt.parser.end?.() ?? []);
        // Surefire / Gradle print only failures and class totals: per-test results come from the XML reports.
        if (frameworkFor(session.config) === "jvm") rt.tests.apply(await jvmReportEvents(session));
        if (runtimes.get(sessionId) !== rt) return;
        rt.tests.finish(code);
        recordTestStates(rt.tests);
      }
      patchSession(sessionId, { status: "finished", exitCode: code, endedAt: Date.now() });
      bump(sessionId);
      notifyExit(sessionId, code);
      try {
        rt.onExit?.(code, !!getSession(sessionId)?.stopped);
      } catch (e) {
        console.error("run exit listener failed", e);
      }
    })();
  }, 30);
}

async function jvmReportEvents(session: RunSession): Promise<TestEvent[]> {
  if (!isTauri()) return [];
  try {
    // Report files are written during the run; allow for coarse file-system timestamps.
    const reports = await call(commands.runTestReports(session.config.cwd ?? null, session.startedAt - 2000));
    return testReportEvents(reports);
  } catch {
    return [];
  }
}

/** JUnit XML report cases → test tree events (`[class, method]`, failure output and source line). */
export function testReportEvents(reports: readonly TestCaseReport[]): TestEvent[] {
  const events: TestEvent[] = [];
  for (const r of reports) {
    if (!r.className || !r.name) continue;
    const path = [r.className, r.name];
    events.push({ type: "result", path, status: r.status, durationMs: r.durationMs ?? undefined });
    if (r.status !== "failed") continue;
    const text = [r.message, r.output].filter(Boolean).join("\n");
    for (const line of text.split("\n").slice(0, 200)) events.push({ type: "output", path, line });
    const outer = r.className.split("$")[0]!;
    const frame = new RegExp(
      `at (${outer.replace(/[.$]/g, "\\$&")}(?:\\$[\\w$]+)?)\\.[\\w$<>]+\\(([\\w$-]+\\.(?:java|kt|groovy|scala)):(\\d+)\\)`,
    ).exec(r.output ?? "");
    if (frame) events.push({ type: "location", path, location: jvmFrameTarget(frame[1], frame[2]!, Number(frame[3])) });
  }
  return events;
}

function notifyExit(sessionId: string, code: number | null) {
  const session = getSession(sessionId);
  if (!session || session.stopped || code === 0 || code === null) return;
  let visible = true;
  try {
    visible = toolWindowService().isVisible("run");
  } catch {
    /* no workbench */
  }
  if (visible) return;
  const tests = runtimes.get(sessionId)?.tests;
  const failed = tests ? tests.counts().failed : 0;
  notifications().notify({
    group: "run",
    level: "error",
    key: `run-exit-${sessionId}`,
    title: failed > 0 ? `Tests failed: ${failed}` : `'${session.config.name}' exited with code ${code}`,
    body: failed > 0 ? session.config.name : undefined,
    actions: [
      {
        label: "Show",
        run: () => {
          useRun.setState({ activeSession: sessionId });
          toolWindowService().show("run", true);
        },
      },
      { label: "Rerun", run: () => void startRun(session.config, sessionId) },
    ],
  });
}

/** Handles the `runExited` backend event. */
export function onRunExited(runId: RunId, code: number | null) {
  const session = useRun.getState().sessions.find((s) => s.runId === runId);
  if (!session) {
    pendingExits.set(runId, code);
    return;
  }
  finishSession(session.id, code);
}

export async function stopSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.runId === null || session.status !== "running") return;
  patchSession(sessionId, { stopped: true });
  try {
    await call(commands.runStop(session.runId));
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot stop process",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Resolves once the given sessions' processes exited (or after `timeoutMs`). */
function waitForExit(sessionIds: readonly string[], timeoutMs = 10_000): Promise<void> {
  const live = () =>
    sessionIds.some((id) => {
      const s = getSession(id);
      return !!s && s.runId !== null && s.status === "running";
    });
  if (!live()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = useRun.subscribe(() => {
      if (!live()) done();
    });
  });
}

export function rerunSession(sessionId: string) {
  const session = getSession(sessionId);
  if (session) void startRun(session.config, sessionId, session.baseConfig);
}

/** Paths of the failed tests of a session's last run. */
export function failedTests(sessionId: string): string[][] {
  const tests = runtimes.get(sessionId)?.tests;
  return tests ? failedTestPaths(tests) : [];
}

/** "Rerun Failed Tests": reruns only the failed tests in the same tab. Returns false when unsupported. */
export function rerunFailed(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session || session.status === "running" || session.status === "starting") return false;
  const base = session.baseConfig ?? session.config;
  const derived = rerunFailedConfig(base, failedTests(sessionId));
  if (!derived) return false;
  void startRun(derived, sessionId, base);
  return true;
}

/**
 * Run / Debug the tests selected in a session's test tree (IDEA: a temporary
 * configuration for them). False when the framework can't filter tests.
 */
export async function runSelectedTests(
  sessionId: string,
  nodeIds: readonly string[],
  debug: boolean,
): Promise<boolean> {
  const session = getSession(sessionId);
  const tests = runtimes.get(sessionId)?.tests;
  if (!session || !tests) return false;
  const nodes = nodeIds.map((id) => tests.get(id)).filter((n) => !!n);
  const paths = leafTestPaths(nodes);
  const base = session.baseConfig ?? session.config;
  const name = nodes.length === 1 ? nodes[0]!.name : `${paths.length} tests`;
  const derived = testsConfig(base, paths, name);
  if (!derived) return false;
  const config = adoptTemporary({
    ...derived,
    id: `context:tests:${base.id}:${paths.map((p) => p.join("/")).join("|")}`,
  });
  if (debug) await executeAction("run.debugConfig", config);
  else await startRun(config);
  return true;
}

/** Whether the console takes typed input: the process runs and its stdin is open. */
export function acceptsInput(session: RunSession): boolean {
  return session.status === "running" && session.runId !== null && !session.stdinClosed;
}

/** Replaces the pending (typed, unsent) console input. */
export function setPendingInput(sessionId: string, text: string) {
  const rt = runtimes.get(sessionId);
  if (!rt || rt.input === text) return;
  rt.input = text;
  bump(sessionId);
}

export async function sendStdin(sessionId: string, text: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.runId === null || session.status !== "running") return;
  // Echo the input the way IDEA does (user input coloured in the console).
  enqueue(sessionId, { kind: "stdout", text: `\x1b[32m${text}\x1b[39m\n` });
  try {
    await call(commands.runStdin(session.runId, text + "\n"));
  } catch (e) {
    enqueue(sessionId, {
      kind: "system",
      text: tx`Cannot write to stdin: ${e instanceof Error ? e.message : String(e)}\n`,
    });
  }
}

/** Keystrokes typed into a console that emulates a terminal, sent as they are. */
export function writeTerminal(sessionId: string, data: string) {
  const session = getSession(sessionId);
  if (!session || session.runId === null || session.status !== "running") return;
  void call(commands.runStdin(session.runId, data)).catch(() => undefined);
}

/** The terminal console's size in cells; the process's terminal follows it. */
export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  const rt = runtimes.get(sessionId);
  if (!rt || cols < 1 || rows < 1) return;
  rt.terminalSize = { cols, rows };
  const session = getSession(sessionId);
  if (session?.runId != null && session.status === "running" && isTauri())
    void call(commands.runResize(session.runId, cols, rows)).catch(() => undefined);
}

export async function closeStdin(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.runId === null || session.status !== "running") return;
  try {
    await call(commands.runCloseStdin(session.runId));
    patchSession(sessionId, { stdinClosed: true });
  } catch {
    /* already closed */
  }
}

export function clearConsole(sessionId: string) {
  runtimes.get(sessionId)?.console.clear();
  runtimes.get(sessionId)?.terminal?.clear();
  bump(sessionId);
}

/** Closing a Run tab: a process still running is terminated once the user agrees, as IDEA asks. */
export async function closeSessionTab(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session) return false;
  const running = session.status === "running" || session.status === "starting";
  if (running && workflowSettings().run.confirmTerminate && !(await confirmTerminate(session.config.name)))
    return false;
  closeSession(sessionId);
  return true;
}

export function closeSession(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return;
  if (session.status === "running") void stopSession(sessionId);
  const rt = runtimes.get(sessionId);
  if (rt?.flushHandle != null) cancelAnimationFrame(rt.flushHandle);
  runtimes.delete(sessionId);
  useRun.setState((s) => {
    const index = s.sessions.findIndex((x) => x.id === sessionId);
    const sessions = s.sessions.filter((x) => x.id !== sessionId);
    const activeSession =
      s.activeSession === sessionId ? (sessions[Math.min(index, sessions.length - 1)]?.id ?? null) : s.activeSession;
    const versions = { ...s.versions };
    delete versions[sessionId];
    return { sessions, activeSession, versions };
  });
}

export function runningSessions(): RunSession[] {
  return useRun.getState().sessions.filter((s) => s.status === "running" || s.status === "starting");
}

/** Stops everything and forgets sessions (project closed). */
export function resetRuns() {
  for (const s of runningSessions()) void stopSession(s.id);
  for (const rt of runtimes.values()) if (rt.flushHandle != null) cancelAnimationFrame(rt.flushHandle);
  runtimes.clear();
  pendingExits.clear();
  useRun.setState({
    configs: [],
    loaded: false,
    loadError: null,
    selectedId: null,
    temporary: [],
    sessions: [],
    activeSession: null,
    versions: {},
    chooserOpen: false,
    chooserMode: "select",
    editorOpen: false,
    editTarget: null,
    editDirty: false,
  });
}

/**
 * "Modify Run Configuration…": `config` becomes the selected temporary
 * configuration and the edit dialog opens on it with pending changes, so OK
 * saves it as a permanent one. Cancel leaves it temporary.
 */
export function modifyTemporary(config: RunConfig) {
  const adopted = adoptTemporary({ ...config, detected: false });
  const unsub = useRun.subscribe((s, prev) => {
    if (s.editorOpen || !prev.editorOpen) return;
    unsub();
    useRun.setState({ editDirty: false });
    // Not saved: back to an ordinary (detected) temporary configuration.
    const st = useRun.getState();
    if (st.temporary.includes(adopted.id))
      useRun.setState({ configs: st.configs.map((c) => (c.id === adopted.id ? { ...c, detected: true } : c)) });
    persistTemporary();
  });
  useRun.setState({
    editorOpen: true,
    chooserOpen: false,
    editTarget: adopted.id,
    editDirty: adopted.detected === false,
  });
}
