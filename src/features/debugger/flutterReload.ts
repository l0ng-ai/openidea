/**
 * Flutter hot reload on save, on by default like Android Studio: saving a Dart file of a
 * running Flutter debug session reloads the app, and a file with errors skips the reload
 * silently because the editor already shows them.
 */
import { onEditorEvent } from "@/editor/api";
import { diagnosticsFor } from "@/editor/lsp/diagnostics";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { dirname } from "@/platform/project";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { appendConsole, isLive, useDebug, type DebugSession } from "./state";

/**
 * Merges a Save All and lets the analyzer publish the saved text's diagnostics (tens of ms).
 * A fixed wait: on a slower analysis the reload goes out and Flutter's compiler
 * rejects it, leaving the app running and the error in the Debug console.
 */
const SETTLE_MS = 300;
/** How far above the entry point `.dart_tool` is looked for (as `is_flutter_project` does for `pubspec.yaml`). */
const MAX_PACKAGE_DEPTH = 6;

/** Saved files not reloaded yet: files with errors keep blocking until fixed, and all wait out a pause. */
const saved = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

const canReload = (s: DebugSession | undefined): s is DebugSession =>
  workflowSettings().debugger.flutterHotReloadOnSave && !!s?.flutterAppStarted && isLive(s) && s.status !== "stopping";

const reloadableSessions = () => Object.values(useDebug.getState().sessions).filter(canReload);

const hasCompileError = (path: string) =>
  diagnosticsFor(path).some((d) => d.severity === "error" && d.source === "dart");

/** Local folders of the packages in `.dart_tool/package_config.json` (`rootUri` is relative to that file). */
export function packageRoots(configText: string, configPath: string): string[] {
  const packages = (JSON.parse(configText) as { packages?: { rootUri?: unknown }[] }).packages ?? [];
  const encoded = configPath.split("/").map(encodeURIComponent).join("/");
  const base = `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
  return packages.flatMap(({ rootUri }) => {
    if (typeof rootUri !== "string") return [];
    const url = new URL(rootUri, base);
    if (url.protocol !== "file:") return [];
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    return [/^\/[A-Za-z]:/.test(path) ? path.slice(1) : path];
  });
}

/** The session's package and the packages it depends on, so a path dependency in a monorepo counts. */
async function sourceRoots(s: DebugSession): Promise<string[]> {
  const start = s.launch?.program ? dirname(s.launch.program) : s.launch?.cwd;
  if (!start) return [];
  let dir = start;
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth++) {
    const file = `${dir}/.dart_tool/package_config.json`;
    const text = await call(commands.fsReadText(file)).catch(() => null);
    if (text !== null) {
      try {
        return packageRoots(text, file);
      } catch {
        break;
      }
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return [start];
}

async function reload(s: DebugSession, paths: string[]): Promise<void> {
  const roots = await sourceRoots(s);
  const own = paths.filter((p) => roots.some((root) => p.startsWith(`${root}/`)));
  if (!own.length || own.some(hasCompileError)) return;
  // The session may have ended while its package list was read.
  if (!canReload(useDebug.getState().sessions[s.id])) return;
  // Flutter queues a reload requested during another one, and reports its own failures in the console.
  await call(commands.debugHotReload(s.id, "save")).catch((e: unknown) => {
    if (!canReload(useDebug.getState().sessions[s.id])) return;
    const reason = e instanceof Error ? e.message : String(e);
    appendConsole(s.id, "console", `${tx`Hot reload on save failed: ${reason}`}\n`);
  });
}

function flush() {
  const paths = [...saved];
  const sessions = reloadableSessions();
  // Flutter skips the rebuild of a paused app, so the screen would stay old after resuming.
  const running = sessions.filter((s) => s.status !== "paused");
  const waiting = running.length < sessions.length;
  saved.clear();
  paths.filter((p) => waiting || hasCompileError(p)).forEach((p) => saved.add(p));
  for (const s of running) void reload(s, paths);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE_MS);
}

export function installFlutterHotReloadOnSave(): () => void {
  const off = onEditorEvent((e) => {
    if (e.type !== "docSaved" || !e.path.endsWith(".dart")) return;
    if (!reloadableSessions().length) return;
    saved.add(e.path);
    schedule();
  });
  const offResume = useDebug.subscribe(({ sessions }, prev) => {
    if (!saved.size || sessions === prev.sessions) return;
    const resumed = Object.values(sessions).some(
      (s) => s.status === "running" && prev.sessions[s.id]?.status === "paused",
    );
    if (resumed) schedule();
  });
  const forget = () => {
    clearTimeout(timer);
    saved.clear();
  };
  // Saves made before the setting was turned off are not replayed when it comes back.
  const offSetting = onWorkflowSettingsChange(
    (settings) => settings.debugger.flutterHotReloadOnSave,
    (enabled) => {
      if (!enabled) forget();
    },
  );
  return () => {
    off();
    offResume();
    offSetting();
    forget();
  };
}
