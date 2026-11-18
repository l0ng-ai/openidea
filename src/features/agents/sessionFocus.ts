/** The agent session holding focus, and those shown elsewhere, for actions scoped to a task view. */
import { setContext } from "@/platform/context";

export interface FocusedSession {
  openFind(): void;
  focusInput?: () => void;
}

let focused: FocusedSession | null = null;
/** Sessions on screen that accept input, least recently focused first. */
let reachable: FocusedSession[] = [];

/** The session `Focus Agent Input` targets: the focused one, else the most recently used shown one. */
export function inputSession(): FocusedSession | null {
  if (focused) return focused.focusInput ? focused : null;
  return reachable.at(-1) ?? null;
}

function publish() {
  setContext("agentSessionFocus", !!focused);
  setContext("agentInputAvailable", !!inputSession());
}

export function setFocusedSession(session: FocusedSession | null) {
  focused = session;
  if (session && reachable.includes(session)) reachable = [...reachable.filter((s) => s !== session), session];
  publish();
}

/** Lists a shown session that accepts input as a target for the shortcut; returns a disposer. */
export function registerReachableSession(session: FocusedSession): () => void {
  reachable = [...reachable.filter((s) => s !== session), session];
  publish();
  return () => {
    reachable = reachable.filter((s) => s !== session);
    publish();
  };
}

export const focusedSession = () => focused;
