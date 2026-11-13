/**
 * The PTY side of the terminal editor tabs (#2202): one `TerminalSession` per tab
 * key. A tab moved from the Terminal tool window brings its running session along;
 * a restored tab starts a login shell (so PATH, nvm and aliases apply) when asked.
 * Sessions outlive React: they belong to the tab, which reattaches the same xterm
 * host when it is shown again.
 */
import { workflowSettings } from "@/platform/workflowSettings";
import { useClis } from "./cli";
import { TerminalSession, type SessionSnapshot } from "./session";

const sessions = new Map<string, TerminalSession>();

export function cliSession(key: string): TerminalSession | undefined {
  return sessions.get(key);
}

function allCliSessions(): TerminalSession[] {
  return [...sessions.values()];
}

export function cliSessionForTerminalId(id: number): TerminalSession | undefined {
  return allCliSessions().find((s) => s.terminalId === id);
}

/** Session whose DOM contains `el` (the focused xterm of an editor tab). */
export function cliSessionFromElement(el: Element | null): TerminalSession | undefined {
  const host = el?.closest?.<HTMLElement>("[data-terminal-session]");
  const key = host?.dataset.terminalSession;
  // A moved session keeps the key it had in the tool window, so match the session's own.
  return key ? allCliSessions().find((s) => s.key === key) : undefined;
}

/** Whether `session` belongs to an editor tab (not to the Terminal tool window). */
export function isCliSession(session: TerminalSession): boolean {
  return allCliSessions().includes(session);
}

function onChange(key: string, snapshot: SessionSnapshot) {
  useClis.setState((s) => ({ sessions: { ...s.sessions, [key]: snapshot } }));
}

/** Tab `key` takes over `session`, a running tool window session (Move to Editor). */
export function adoptCli(key: string, session: TerminalSession) {
  sessions.set(key, session);
  session.rebind({ onChange: (_, snapshot) => onChange(key, snapshot), onFocus() {}, onExit: undefined });
}

/**
 * Starts tab `key`'s session in `cwd` (else `fallbackRoot`): a login shell that runs
 * `command` first (an empty command is a plain shell). Started tabs are returned as they are.
 */
export function startCli(key: string, cwd: string, command: string, fallbackRoot?: string): TerminalSession {
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new TerminalSession({ key, cwd, fallbackRoot, onChange, onFocus() {} });
  sessions.set(key, session);
  useClis.setState((s) => ({ sessions: { ...s.sessions, [key]: session.state } }));
  // Typed while the PTY is still starting: sent as the shell's first input.
  if (command) session.input(`${command}\r`);
  return session;
}

/** Ends the session of a closed tab. */
export function disposeCli(key: string) {
  sessions.get(key)?.dispose();
  sessions.delete(key);
  useClis.setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[key];
    return { sessions };
  });
}

/** The project switched: the tabs are closed by the editor without `onClose`, so end the sessions here. */
export function disposeAllClis() {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  useClis.setState({ sessions: {} });
}

/**
 * Whether tab `key` is busy (closing it would end a running CLI). A shell-integration
 * report is known without asking; otherwise the backend judges the PTY, which may wait.
 */
export function cliBusy(key: string): boolean | Promise<boolean> {
  const session = sessions.get(key);
  if (!session || session.state.status !== "running") return false;
  return session.state.commandRunning || session.isBusy();
}

export function applySettingsToClis() {
  const t = workflowSettings().terminal;
  for (const session of sessions.values()) session.applySettings(t);
}

export function applyThemeToClis() {
  for (const session of sessions.values()) session.applyTheme();
}
