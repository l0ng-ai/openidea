/**
 * Running the context (IDEA's "Run '<name>'" / "Debug '<name>'" / "Modify Run
 * Configuration…"): ⌃⇧R / ⌃⇧D, the editor, project view and editor tab
 * context menus and the run gutter all go through `produceContext`, then the
 * produced configuration is adopted as the selected temporary configuration.
 */
import { activeEditor } from "@/editor/api";
import { executeAction, getAction } from "@/platform/actions";
import { call, commands, isTauri, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { showContextMenu, type MenuItem } from "@/ui";
import {
  maybeEditorService,
  notifications,
  runExecutors,
  type ContextMenuId,
  type MenuGroupContext,
} from "@/workbench/contributions";
import {
  neededTools,
  OPTIMISTIC,
  produceContext,
  produceContextChoices,
  produceDirectory,
  produceFile,
  scriptLanguage,
  type ContextInput,
  type Produced,
} from "./producers";
import { runWithExecutor } from "./executors";
import { goModulePath, loadGoModules } from "./goModules";
import { remoteDebugBlocked } from "./remote";
import { toolEnv } from "./runtimes";
import { adoptTemporary, loadConfigs, modifyTemporary, startRun, useRun } from "./store";
import { tx } from "@/platform/i18n";

const CONTENT_LIMIT = 400_000;

async function ensureConfigs() {
  if (!useRun.getState().loaded) await loadConfigs();
}

/** The focused editor's file, text and caret line. */
export function editorInput(): ContextInput | null {
  const path = maybeEditorService()?.activePath() ?? activeEditor()?.ctx.path ?? null;
  if (!path || isVirtualUri(path)) return null;
  const editor = activeEditor();
  const same = editor && editor.ctx.path === path;
  const state = same ? editor.view.state : null;
  return {
    path,
    root: useProject.getState().project?.root ?? null,
    configs: useRun.getState().configs,
    content: state ? state.doc.sliceString(0, CONTENT_LIMIT) : undefined,
    line: state ? state.doc.lineAt(state.selection.main.head).number - 1 : undefined,
    goModule: goModulePath,
  };
}

/** Production with the runtimes looked up (launches, Modify Run Configuration…). */
export async function produceResolved(input: ContextInput, dir = false): Promise<Produced | null> {
  const configs = useRun.getState().configs;
  if (dir || /\.go$/.test(input.path)) await loadGoModules(input.root, configs);
  if (dir) return produceDirectory({ ...input, goModule: goModulePath });
  const fresh = { ...input, configs, goModule: goModulePath };
  const named = produceContext(fresh, OPTIMISTIC);
  if (!named) return null;
  // Project configurations (tests, cargo, gradle…) need no runtime lookup.
  if (named.config && !named.config.id.startsWith("context:file:")) return named;
  const lang = scriptLanguage(input.path, input.content);
  const env = await toolEnv(neededTools(fresh), input.path, fresh.root, lang === "python" || lang === "shebang");
  return produceContext(fresh, env);
}

function reportMissing(p: Produced) {
  if (!p.missing) return;
  notifications().notify({
    group: "run",
    level: "warning",
    title: p.missing.title,
    body: p.missing.body,
    key: "run-context-missing",
  });
}

/** Builds with `build` in the Run window; resolves whether it succeeded. */
async function buildFirst(build: RunConfig): Promise<boolean> {
  const session = await startRun(build);
  if (!session) return false;
  return new Promise((resolve) => {
    const check = () => {
      const s = useRun.getState().sessions.find((x) => x.id === session.id);
      if (!s) return true;
      if (s.status === "failed") return (resolve(false), true);
      if (s.status === "finished") return (resolve(s.exitCode === 0), true);
      return false;
    };
    if (check()) return;
    const unsub = useRun.subscribe(() => {
      if (check()) unsub();
    });
  });
}

/** Runs or debugs a production (adopting it as the selected temporary configuration). */
export async function launchProduced(p: Produced, debug: boolean): Promise<void> {
  if (p.missing || !p.config) {
    reportMissing(p);
    return;
  }
  const config = adoptTemporary(p.config);
  if (!debug) {
    await startRun(config);
    return;
  }
  if (remoteDebugBlocked(config)) return;
  if (p.debug) {
    if (!getAction("debug.startConfig")) {
      notifications().notify({
        group: "run",
        level: "warning",
        title: "Debugger is not available",
        key: "run-no-debugger",
      });
      return;
    }
    if (!(await buildFirst(p.debug.build))) return;
    await executeAction("debug.startConfig", { config: p.debug.config, origin: config });
    return;
  }
  await executeAction("run.debugConfig", config);
}

/**
 * The debug plan of a compiled single-file configuration (kinds `rustc` / `cc`)
 * picked from the Run widget: re-produced from the source file in its id.
 */
export async function compiledDebugPlan(config: RunConfig): Promise<Produced | null> {
  if (config.kind !== "rustc" && config.kind !== "cc") return null;
  const m = /^context:file:(.+?)(?:#(.+))?$/.exec(config.id);
  if (!m) return null;
  const root = useProject.getState().project?.root ?? null;
  const path = m[1]!.startsWith("/") || !root ? m[1]! : `${root}/${m[1]}`;
  let content: string | undefined;
  try {
    content = isTauri() ? await call(commands.fsReadText(path)) : undefined;
  } catch {
    return null;
  }
  const input: ContextInput = { path, root, configs: useRun.getState().configs, content };
  const env = await toolEnv(neededTools(input), path, root, false);
  if (m[2]) {
    // A test: find the target by name again.
    const lines = (content ?? "").split("\n");
    const line = lines.findIndex((l) =>
      new RegExp(`\\bfn\\s+${m[2]!.split("::").pop()}\\b|\\bmod\\s+${m[2]}\\b`).test(l),
    );
    return line >= 0 ? produceContext({ ...input, line }, env) : null;
  }
  return produceFile(input, env);
}

/** ⌃⇧R / ⌃⇧D: the innermost context at the caret of the active editor. */
/** Reads the file when the context has no text yet (`#!` lines, `package main`, `fn main`…). */
async function withContent<T extends ContextInput & { dir?: boolean }>(input: T): Promise<T> {
  if (input.content !== undefined || input.dir || !isTauri() || isVirtualUri(input.path)) return input;
  try {
    return { ...input, content: (await call(commands.fsReadText(input.path))).slice(0, CONTENT_LIMIT) };
  } catch {
    return input;
  }
}

export async function runContextAction(debug: boolean, arg?: unknown): Promise<boolean> {
  await ensureConfigs();
  const target = await withArgContent(arg);
  const input = target ?? editorInput();
  if (!input) return false;
  const dir = target?.dir ?? false;
  const choices = dir
    ? []
    : produceContextChoices({ ...input, configs: useRun.getState().configs, goModule: goModulePath }, OPTIMISTIC);
  if (choices.length > 1) {
    // Several test configurations match equally well: like IDEA, let the user choose.
    showContextMenu(chooserPoint(target === null), choiceItems(choices, debug));
    return true;
  }
  const p = await produceResolved(input, dir);
  if (!p) return false;
  await launchProduced(p, debug);
  return true;
}

/** Menu entries for each of several productions: "Run '<name>'" with the configuration it derives from. */
export function choiceItems(choices: readonly Produced[], debug: boolean): MenuItem[] {
  return [
    { kind: "header", label: debug ? "Choose configuration to debug" : "Choose configuration to run" },
    ...choices.map((p): MenuItem => ({
      label: debug ? tx`Debug '${p.name}'` : tx`Run '${p.name}'`,
      verbatim: true,
      icon: debug ? "debug" : "run",
      shortcut: p.detail,
      run: () => void launchProduced(p, debug),
    })),
  ];
}

/** Below the caret for the editor context, else the middle of the window. */
function chooserPoint(fromEditor: boolean): { x: number; y: number } {
  const editor = fromEditor ? activeEditor() : null;
  const caret = editor?.view.coordsAtPos(editor.view.state.selection.main.head);
  if (caret) return { x: caret.left, y: caret.bottom + 2 };
  return { x: Math.round(window.innerWidth / 2 - 120), y: Math.round(window.innerHeight / 3) };
}

/** Runs the context with a run executor (Run with Coverage, Profile…). False when there is nothing to run. */
export async function executeContext(executor: string, arg?: unknown): Promise<boolean> {
  await ensureConfigs();
  const target = await withArgContent(arg);
  const input = target ?? editorInput();
  if (!input) return false;
  const p = await produceResolved(input, target?.dir ?? false);
  if (!p) return false;
  if (p.missing || !p.config) {
    reportMissing(p);
    return true;
  }
  await runWithExecutor(adoptTemporary(p.config), executor);
  return true;
}

/** "Run '<name>' with Coverage", "Profile '<name>'"… for a context the executors can run. */
export function executorItems(config: RunConfig | null | undefined, name: string, context: ContextArg): MenuItem[] {
  if (!config) return [];
  return runExecutors()
    .filter((e) => e.supports(config))
    .map((e) => ({
      kind: "action",
      action: "run.withExecutor",
      arg: { executor: e.id, context },
      label: e.label(name),
      icon: e.icon,
    }));
}

export interface ContextArg {
  path: string;
  line?: number;
  dir?: boolean;
  content?: string;
}

async function withArgContent(arg: unknown) {
  const target = contextArg(arg);
  return target ? withContent(target) : null;
}

function contextArg(arg: unknown): (ContextInput & { dir?: boolean }) | null {
  if (!arg || typeof arg !== "object" || typeof (arg as ContextArg).path !== "string") return null;
  const a = arg as ContextArg;
  const editor = activeEditor();
  const state = editor && editor.ctx.path === a.path ? editor.view.state : null;
  return {
    path: a.path,
    dir: a.dir,
    root: useProject.getState().project?.root ?? null,
    configs: useRun.getState().configs,
    content: a.content ?? state?.doc.sliceString(0, CONTENT_LIMIT) ?? peekContent(a.path),
    line: a.line,
    goModule: goModulePath,
  };
}

/** "Modify Run Configuration…": the would-be configuration in Edit Configurations. */
export async function modifyContext(arg?: unknown): Promise<void> {
  await ensureConfigs();
  const target = await withArgContent(arg);
  const input = target ?? editorInput();
  if (!input) return;
  const p = await produceResolved(input, target?.dir ?? false);
  if (!p) return;
  if (!p.config) {
    reportMissing(p);
    return;
  }
  modifyTemporary(p.config);
}

// ---------------------------------------------------------------------------
// Context menus

/** File text read for the project view menu (files not open in an editor). */
const peeked = new Map<string, { at: number; text: string }>();
const PEEK_TTL = 10_000;

function peekContent(path: string): string | undefined {
  const hit = peeked.get(path);
  return hit && Date.now() - hit.at < PEEK_TTL ? hit.text : undefined;
}

/** Whether the file's runnability depends on its text (`package main`, `fn main`, `#!`…). */
function needsContent(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /\.(go|rs|java|kt|c|cpp|cc|cxx)$/.test(name) || !name.includes(".");
}

export async function prepareMenu(_menu: ContextMenuId, ctx: MenuGroupContext): Promise<void> {
  if (ctx.paths.length !== 1) return;
  const path = ctx.paths[0]!;
  if (ctx.dirs?.[0] || /\.go$/.test(path))
    await loadGoModules(useProject.getState().project?.root ?? null, useRun.getState().configs).catch(() => {});
  if (ctx.text !== undefined || ctx.dirs?.[0]) return;
  if (!needsContent(path) || peekContent(path) !== undefined || !isTauri() || isVirtualUri(path)) return;
  const text = await call(commands.fsReadText(path));
  peeked.set(path, { at: Date.now(), text: text.slice(0, CONTENT_LIMIT) });
}

/** The run group of a context menu: Run / Debug '<name>', Modify Run Configuration…. */
export function contextMenuItems(menu: ContextMenuId, ctx: MenuGroupContext): MenuItem[] {
  if (ctx.paths.length !== 1) return [];
  const path = ctx.paths[0]!;
  if (isVirtualUri(path)) return [];
  const root = useProject.getState().project?.root ?? null;
  if (!root) return [];
  const dir = !!ctx.dirs?.[0];
  const content = ctx.text ?? peekContent(path);
  const line = menu === "editor" ? ctx.line : undefined;
  const input: ContextInput = {
    path,
    root,
    configs: useRun.getState().configs,
    content: content?.slice(0, CONTENT_LIMIT),
    line,
    goModule: goModulePath,
  };
  const p = dir ? produceDirectory(input) : produceContext(input, OPTIMISTIC);
  if (!p) return [];
  const arg: ContextArg = { path, line, dir, content: dir ? undefined : input.content };
  return [
    { kind: "action", action: "run.runContext", arg, label: tx`Run '${p.name}'`, icon: "run" },
    // Like IDEA, Debug only where a debugger can run it.
    ...(p.debug || p.config?.debugAdapter || p.missing
      ? ([
          { kind: "action", action: "run.debugContext", arg, label: tx`Debug '${p.name}'`, icon: "debug" },
        ] as MenuItem[])
      : []),
    {
      label: "More Run/Debug",
      submenu: [
        ...executorItems(p.config, p.name, arg),
        { kind: "action", action: "run.modifyContext", arg, label: "Modify Run Configuration…", icon: "edit" },
      ],
    },
  ];
}
