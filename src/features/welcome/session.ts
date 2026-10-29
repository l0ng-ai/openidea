/**
 * "Reopen last project on startup" (IDEA: Settings › Appearance & Behavior ›
 * System Settings). The project open when the app last quit is remembered;
 * closing a project explicitly forgets it, so the next start shows the welcome screen.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { commands, isTauri, type Settings } from "@/platform/ipc";
import { openProject, startupLaunchHandled, useProject } from "@/platform/project";
import { connectRemote, parseRemoteLocation, projectLocation } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

const SESSION_KEY = "openidea.session.openProject";
const PREF_KEY = "openidea.welcome.reopenLastProject";
/** Per-window (sessionStorage): the project this window shows, restored when the webview reloads. */
const WINDOW_KEY = "openidea.window.project";

function windowProject(value?: string | null): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(WINDOW_KEY);
    if (value === null) sessionStorage.removeItem(WINDOW_KEY);
    else sessionStorage.setItem(WINDOW_KEY, value);
  } catch {
    /* storage unavailable */
  }
  return null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const useSession = create<{ reopenPref: boolean; reopening: string | null }>(() => ({
  reopenPref: read(PREF_KEY) !== "false",
  reopening: null,
}));

export function setReopenPreference(on: boolean) {
  write(PREF_KEY, on ? "true" : "false");
  useSession.setState({ reopenPref: on });
}

/** `general.reopenLastProject` from settings when present, else the local preference. */
export function reopenEnabled(settings: Settings | null | undefined, pref: boolean): boolean {
  const general = (settings as { general?: { reopenLastProject?: unknown } } | null | undefined)?.general;
  return typeof general?.reopenLastProject === "boolean" ? general.reopenLastProject : pref;
}

/** Keeps the remembered project in sync: set while a project is open, cleared on explicit close. */
export function trackSession(): () => void {
  const root = projectLocation(useProject.getState().project?.root);
  if (root) {
    write(SESSION_KEY, root);
    windowProject(root);
  }
  return useProject.subscribe((s, prev) => {
    // A remote project is remembered by its location (`ssh://…`), reopened over SSH.
    const now = projectLocation(s.project?.root);
    const before = projectLocation(prev.project?.root);
    if (now === before) return;
    if (now) write(SESSION_KEY, now);
    else if (before && !useSession.getState().reopening) write(SESSION_KEY, null);
    if (now || !useSession.getState().reopening) windowProject(now);
  });
}

export function lastSessionProject(): string | null {
  return read(SESSION_KEY);
}

let attempted = false;

/** On startup: reopens the project that was open at exit. Robust against a missing folder. */
export async function reopenLastProject(): Promise<void> {
  if (attempted || !isTauri()) return;
  attempted = true;
  // An explicit launch wins over both this window's and the last session's project.
  await startupLaunchHandled();
  const startup = useProject.getState();
  if (startup.project || startup.lightEdit) return;
  // A reloaded webview gets back its own project, whatever window it is.
  const own = windowProject();
  if (own) {
    await reopen(own);
    return;
  }
  // Secondary windows open the project they were created for (features/app/windows.ts).
  if (getCurrentWindow().label !== "main") return;
  const path = lastSessionProject();
  if (!path) return;
  let settings: Settings | null = null;
  try {
    settings = await commands.settingsGet();
  } catch {
    /* use the local preference */
  }
  if (!reopenEnabled(settings, useSession.getState().reopenPref)) return;
  const current = useProject.getState();
  if (current.project || current.lightEdit) return;
  await reopen(path);
}

async function reopen(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  useSession.setState({ reopening: path });
  try {
    const remote = parseRemoteLocation(path);
    if (remote) await connectRemote(remote.sshConfig, remote.path);
    else await openProject(path);
  } catch (e) {
    write(SESSION_KEY, null);
    windowProject(null);
    notifications().notify({
      level: "warning",
      title: `Cannot reopen ${name}`,
      body: e instanceof Error ? e.message : String(e),
      key: "welcome.reopen",
    });
  } finally {
    useSession.setState({ reopening: null });
  }
}

/** Tests only. */
export function _resetSessionForTests() {
  attempted = false;
  useSession.setState({ reopening: null, reopenPref: read(PREF_KEY) !== "false" });
}
