/**
 * Recording the CPU profile of a debugged page: js-debug samples the page between Start and
 * Stop, and the recording opens in the Profiler tool window like any other snapshot.
 */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { activeSession, isLive, useDebug, type DebugSession } from "../state";

/** Page sessions whose CPU profile is being recorded. */
export const useJsProfile = create<{ recording: Record<number, boolean> }>(() => ({ recording: {} }));

export const isPageProfiled = (session: number) => !!useJsProfile.getState().recording[session];

function setRecording(session: number, on: boolean) {
  useJsProfile.setState((s) => {
    const recording = { ...s.recording };
    if (on) recording[session] = true;
    else delete recording[session];
    return { recording };
  });
}

/** The selected session when it debugs a page. */
function selectedPage(): DebugSession | null {
  const s = activeSession();
  return s && isLive(s) && s.caps?.jsPage ? s : null;
}

export async function startPageProfile(): Promise<void> {
  const page = selectedPage();
  if (!page || isPageProfiled(page.id)) return;
  try {
    await call(commands.debugJsStartProfile(page.id));
    setRecording(page.id, true);
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "warning",
      title: "Cannot record a CPU profile",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function stopPageProfile(): Promise<void> {
  const page = selectedPage();
  if (!page || !isPageProfiled(page.id)) return;
  setRecording(page.id, false);
  try {
    const dir = await call(commands.debugJsStopProfile(page.id));
    const root = useProject.getState().project?.root ?? "";
    await executeAction("profiler.showCpuProfiles", { name: page.name, dir, root });
  } catch {
    // The page ended while it was recorded: there is no profile to show.
  }
}

/** The More menu's entry of a session: Start or Stop for a page, nothing for any other program. */
export function pageProfileItems(page: boolean, recording: boolean): MenuItem[] {
  if (!page) return [];
  return [
    { kind: "separator" },
    { kind: "action", action: recording ? "debug.stopPageProfile" : "debug.startPageProfile", icon: "profile" },
  ];
}

function publishProfiled() {
  const page = selectedPage();
  setContext("debugPageProfiled", !!page && isPageProfiled(page.id));
}

/**
 * Forgets the recording of a session that ended, and keeps `debugPageProfiled` on the selected
 * session. Returns the unsubscribe function.
 */
export function watchProfiledSessions(): () => void {
  const offSessions = useDebug.subscribe((s) => {
    for (const id of Object.keys(useJsProfile.getState().recording)) {
      const session = s.sessions[+id];
      if (!session || !isLive(session)) setRecording(+id, false);
    }
    publishProfiled();
  });
  const offRecording = useJsProfile.subscribe(publishProfiled);
  return () => {
    offSessions();
    offRecording();
  };
}
