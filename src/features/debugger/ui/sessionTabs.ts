import { isBrowserLaunch } from "../browser";
import type { DebugSession } from "../state";

export interface SessionTab {
  session: DebugSession;
  /** The session the tab's close button ends: the tab's own, or the launch it stands for. */
  owner: number;
  /** Shown as a child of another tab's session. */
  child: boolean;
}

/**
 * One tab per debug session, except that a browser launch is one tab: js-debug runs it as an
 * empty session for the launch and a child for the page, and only the page has anything to show.
 */
export function sessionTabs(sessions: readonly DebugSession[]): SessionTab[] {
  const parents = new Set(sessions.map((s) => s.parent));
  const launches = new Set(
    sessions.filter((s) => s.parent == null && isBrowserLaunch(s.launch) && parents.has(s.id)).map((s) => s.id),
  );
  return sessions
    .filter((s) => !launches.has(s.id))
    .map((s) => {
      const page = s.parent != null && launches.has(s.parent);
      return { session: s, owner: page ? s.parent! : s.id, child: s.parent != null && !page };
    });
}
