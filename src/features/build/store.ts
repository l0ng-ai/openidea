/**
 * Build › Build Project state: one build at a time, run by the backend
 * (`build_run`) with its output streamed into the Build tool window, progress
 * as a cancellable background task and a notification when it finishes.
 * Compiler messages reach the Problems view and editors as `build`
 * diagnostics, published (and cleared on the next build) by the backend.
 *
 * Like IDEA, the tool window is not shown when a build starts; a failed build
 * shows it, selects the first error and opens its location in the editor.
 */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { setContext } from "@/platform/context";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type BuildEvent,
  type BuildKind,
  type BuildMessage,
  type BuildResult,
  type BuildSystem,
  type RequestId,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { cancelTask, removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { appendOutput, finishSummary, firstError, messageFiles, type BuildStatus, type ConsoleLine } from "./model";

export const BUILD_TASK_ID = "build:compile";
export const BUILD_RUNNING = "build.running";
/** Outcome of the last build (`success` | `failed` | `cancelled`), e.g. for Run's "Build" before launch task. */
export const BUILD_LAST_STATUS = "build.lastStatus";

/** How builds reach the backend; replaced in tests. */
export interface BuildBackend {
  run(
    kind: BuildKind,
    file: string | null,
    request: RequestId,
    clear: string[],
    onEvent: (e: BuildEvent) => void,
  ): Promise<BuildResult>;
  cancel(request: RequestId): void;
}

const tauriBackend: BuildBackend = {
  run(kind, file, request, clear, onEvent) {
    const channel = new Channel<BuildEvent>();
    channel.onmessage = onEvent;
    return call(commands.buildRun(kind, file, request, clear, channel));
  },
  cancel(request) {
    void commands.cancelRequest(request);
  },
};

let backend: BuildBackend = tauriBackend;

export function setBuildBackend(b: BuildBackend | null) {
  backend = b ?? tauriBackend;
}

export interface BuildState {
  request: RequestId | null;
  kind: BuildKind | null;
  /** Module file or folder of a Build Module, `null` for the project. */
  file: string | null;
  title: string;
  system: BuildSystem | null;
  status: BuildStatus | null;
  message: string | null;
  durationMs: number | null;
  messages: BuildMessage[];
  lines: ConsoleLine[];
  /** Files with diagnostics from the last build. */
  files: string[];
  /** Key of the selected tree node (a message node shows its detail beside the tree). */
  selected: string | null;
}

const INITIAL: BuildState = {
  request: null,
  kind: null,
  file: null,
  title: "",
  system: null,
  status: null,
  message: null,
  durationMs: null,
  messages: [],
  lines: [],
  files: [],
  selected: null,
};

export const useBuildRun = create<BuildState>(() => INITIAL);

const TITLES: Record<BuildKind, string> = { build: "Build", rebuild: "Rebuild", artifacts: "Build Artifacts" };

/** Applies one streamed event (pure; batched by the caller). */
export function applyBuildEvent(s: BuildState, e: BuildEvent): Partial<BuildState> {
  switch (e.kind) {
    case "started":
      return { title: e.title, system: e.system };
    case "step":
      return { lines: appendOutput(s.lines, `${e.command}\n`, "system") };
    case "output":
      return { lines: appendOutput(s.lines, e.text, e.stderr ? "err" : "out") };
    case "message":
      return { messages: [...s.messages, e.message] };
    case "progress":
      return { message: e.message };
  }
}

export function isBuilding(): boolean {
  return useBuildRun.getState().status === "running";
}

/**
 * Builds the project (`file` null) or the module containing `file`. Saves all
 * documents first; a second build while one runs is ignored (IDEA disables the actions).
 */
export async function startBuild(kind: BuildKind, file: string | null = null): Promise<BuildResult | null> {
  if (isBuilding() || !useProject.getState().project) return null;
  const request = nextRequestId();
  const taskTitle = TITLES[kind];
  const cancel = () => backend.cancel(request);
  const previous = useBuildRun.getState().files;
  useBuildRun.setState({ ...INITIAL, request, kind, file, title: taskTitle, status: "running", files: previous });
  setContext(BUILD_RUNNING, true);
  upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: null, fraction: null, done: false, cancel });
  await maybeEditorService()
    ?.saveAll()
    .catch(() => undefined);

  let queue: BuildEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const events = queue;
    queue = [];
    if (useBuildRun.getState().request !== request || !events.length) return;
    let s = useBuildRun.getState();
    for (const e of events) s = { ...s, ...applyBuildEvent(s, e) };
    useBuildRun.setState(s);
    if (s.message)
      upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: s.message, fraction: null, done: false, cancel });
  };
  const onEvent = (e: BuildEvent) => {
    queue.push(e);
    timer ??= setTimeout(flush, 16);
  };

  let result: BuildResult | null = null;
  try {
    result = await backend.run(kind, file, request, previous, onEvent);
    clearTimeout(timer);
    flush();
    const status: BuildStatus = result.success ? "success" : "failed";
    useBuildRun.setState({
      status,
      title: result.title,
      system: result.system,
      messages: result.messages,
      durationMs: result.durationMs,
      files: messageFiles(result.messages),
      message: null,
    });
    const summary = finishSummary(result);
    notifications().notify({
      group: "run",
      level: result.success ? (result.warnings ? "warning" : "info") : "error",
      title: summary,
      key: "build-finished",
      sticky: false,
      actions:
        result.success && !result.warnings
          ? undefined
          : [{ label: "Show Build", run: () => toolWindowService().show("build", true) }],
    });
    if (!result.success) showFailure();
  } catch (e) {
    clearTimeout(timer);
    flush();
    if (isCancelled(e)) {
      useBuildRun.setState({ status: "cancelled", files: [], message: null });
    } else {
      const text = e instanceof Error ? e.message : String(e);
      useBuildRun.setState((s) => ({
        status: "failed",
        files: [],
        message: null,
        lines: appendOutput(s.lines, `${text}\n`, "err"),
        messages: [...s.messages, { severity: "error", text, path: null, range: null, code: null }],
      }));
      notifications().notify({
        group: "run",
        level: "error",
        title: "Build failed",
        body: text,
        key: "build-finished",
      });
      showFailure();
    }
  } finally {
    if (useBuildRun.getState().request === request) useBuildRun.setState({ request: null });
    setContext(
      BUILD_LAST_STATUS,
      result?.success ? "success" : useBuildRun.getState().status === "cancelled" ? "cancelled" : "failed",
    );
    setContext(BUILD_RUNNING, false);
    upsertTask({ id: BUILD_TASK_ID, title: taskTitle, message: null, fraction: 1, done: true });
  }
  return result;
}

/** Opens the source of a build message; `focus` moves focus to the editor (otherwise a preview). */
export function navigateToMessage(m: BuildMessage, focus: boolean) {
  if (!m.path) return;
  const start = m.range?.start;
  void maybeEditorService()
    ?.openFile(m.path, { selection: start ? { line: start.line, col: start.col } : undefined, focus, preview: !focus })
    .catch(() => undefined);
}

export function selectBuildNode(key: string | null) {
  if (useBuildRun.getState().selected !== key) useBuildRun.setState({ selected: key });
}

/**
 * A failed build activates the tool window without focusing it, selects the
 * first error and navigates to it, as IDEA does by default.
 */
function showFailure() {
  try {
    toolWindowService().show("build", false);
  } catch {
    // No workbench (tests / settings window).
  }
  const first = firstError(useBuildRun.getState().messages);
  if (!first) return;
  selectBuildNode(first.key);
  navigateToMessage(first.message, true);
}

export function stopBuild() {
  const { request } = useBuildRun.getState();
  if (request == null) return;
  // Through the task, so its progress says "Cancelling…" until the build has stopped.
  if (useTasks.getState().tasks.some((t) => t.id === BUILD_TASK_ID && t.cancel)) cancelTask(BUILD_TASK_ID);
  else backend.cancel(request);
}

/** Runs the last build again (the tool window's rerun button). */
export function rerunBuild() {
  const { kind, file } = useBuildRun.getState();
  return startBuild(kind ?? "build", file);
}

export function resetBuildRun() {
  stopBuild();
  removeTask(BUILD_TASK_ID);
  setContext(BUILD_RUNNING, false);
  useBuildRun.setState(INITIAL);
}
