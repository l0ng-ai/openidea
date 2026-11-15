/** The agent session holding focus, for actions scoped to that task view. */
import { setContext } from "@/platform/context";

export interface FocusedSession {
  openFind(): void;
  focusInput?: () => void;
}

let focused: FocusedSession | null = null;

export function setFocusedSession(session: FocusedSession | null) {
  focused = session;
  setContext("agentSessionFocus", !!session);
  setContext("agentInputAvailable", !!session?.focusInput);
}

export const focusedSession = () => focused;
