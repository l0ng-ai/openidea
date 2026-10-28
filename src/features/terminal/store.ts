/**
 * Terminal tabs and panes. Tab metadata lives in a zustand store for React;
 * the xterm sessions themselves live in a plain map (they own DOM + PTY).
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import { t } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirm } from "@/workbench/messages";
import { TerminalSession, type SessionOptions, type SessionSnapshot } from "./session";

export type SplitOrientation = "horizontal" | "vertical";

/** A session key, or a split of nested layouts. `horizontal` = side by side, `vertical` = stacked. */
export type PaneLayout = string | PaneSplit;
export interface PaneSplit {
  id: string;
  orientation: SplitOrientation;
  children: PaneLayout[];
}

export interface TerminalTab {
  id: string;
  /** Default name ("Local", "Local (2)", or the directory name for "Open in Terminal"). */
  name: string;
  /** Set by the user via rename; wins over `name`. */
  customName: string | null;
  /** Session keys, in display order. */
  panes: string[];
  layout: PaneLayout;
  activePane: string;
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTab: string | null;
  sessions: Record<string, SessionSnapshot>;
}

export const useTerminals = create<TerminalState>(() => ({ tabs: [], activeTab: null, sessions: {} }));

const sessions = new Map<string, TerminalSession>();
let seq = 0;

export function getSession(key: string): TerminalSession | undefined {
  return sessions.get(key);
}

export function allSessions(): TerminalSession[] {
  return [...sessions.values()];
}

export function sessionForTerminalId(id: number): TerminalSession | undefined {
  return allSessions().find((s) => s.terminalId === id);
}

function createSession(cwd: string, command?: SessionOptions["command"]): TerminalSession {
  const key = `s${++seq}`;
  const session = new TerminalSession({
    key,
    cwd,
    command,
    onChange: (k, snapshot) => useTerminals.setState((s) => ({ sessions: { ...s.sessions, [k]: snapshot } })),
    onFocus: (k) => {
      const tab = useTerminals.getState().tabs.find((t) => t.panes.includes(k));
      if (tab) setActivePane(tab.id, k);
    },
    onExit: (k) => {
      if (workflowSettings().terminal.closeOnExit) closePane(k);
    },
  });
  sessions.set(key, session);
  useTerminals.setState((s) => ({ sessions: { ...s.sessions, [key]: session.state } }));
  return session;
}

function disposeSession(key: string) {
  sessions.get(key)?.dispose();
  sessions.delete(key);
  useTerminals.setState((s) => {
    const next = { ...s.sessions };
    delete next[key];
    return { sessions: next };
  });
}

/** Next free default name: "Local", "Local (2)", … */
export function nextTabName(existing: readonly string[], base = "Local"): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base} (${i})`;
    if (!existing.includes(name)) return name;
  }
}

/** Shortens `text` to `max` characters by eliding its middle. */
export function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

const APP_TITLE_MAX = 30;

/** The title the program in the tab's active pane set, while a command runs (at the prompt it is the shell's own). */
function appTitle(tab: TerminalTab, sessions?: Record<string, SessionSnapshot>): string | null {
  const s = sessions?.[tab.activePane];
  return s?.commandRunning ? s.appTitle : null;
}

/**
 * The tab's label: a name the user gave it, else the title the running command
 * set (OSC 0/2, middle-trimmed), else the default name.
 */
export function tabTitle(tab: TerminalTab, sessions?: Record<string, SessionSnapshot>): string {
  if (tab.customName) return tab.customName;
  const app = appTitle(tab, sessions);
  return app ? trimMiddle(app, APP_TITLE_MAX) : tab.name;
}

/** Untrimmed title for the tab's tooltip. */
export function tabFullTitle(tab: TerminalTab, sessions?: Record<string, SessionSnapshot>): string {
  return tab.customName ?? appTitle(tab, sessions) ?? tab.name;
}

/** Settings › Terminal › Start directory, resolved against the project root. */
export function startDirectory(root: string): string {
  const dir = workflowSettings().terminal.startDirectory.replace(/\/+$/, "");
  if (!dir) return root;
  if (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) return dir;
  if (dir.startsWith("~/")) return dir;
  return `${root.replace(/\/+$/, "")}/${dir.replace(/^\.\//, "")}`;
}

export function newTab(cwd: string, name?: string, command?: SessionOptions["command"]): TerminalTab {
  const session = createSession(cwd, command);
  const { tabs } = useTerminals.getState();
  const tab: TerminalTab = {
    id: `t${seq}`,
    name: nextTabName(
      tabs.map((t) => t.name),
      name ?? workflowSettings().terminal.tabName,
    ),
    customName: null,
    panes: [session.key],
    layout: session.key,
    activePane: session.key,
  };
  useTerminals.setState((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }));
  return tab;
}

export function newTabAt(dir: string): TerminalTab {
  return newTab(dir, basename(dir) || "Local");
}

export function closeTab(id: string) {
  const { tabs, activeTab } = useTerminals.getState();
  const index = tabs.findIndex((t) => t.id === id);
  const tab = tabs[index];
  if (!tab) return;
  tab.panes.forEach(disposeSession);
  const rest = tabs.filter((t) => t.id !== id);
  const nextActive = activeTab === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : activeTab;
  useTerminals.setState({ tabs: rest, activeTab: nextActive });
}

/**
 * Asks before ending sessions that are running a command, like IDEA
 * (Terminate / Cancel). Resolves true to go ahead.
 */
export async function confirmEndSessions(keys: readonly string[], name: string): Promise<boolean> {
  const busy = await Promise.all(keys.map((k) => sessions.get(k)?.isBusy() ?? false));
  if (!busy.some(Boolean)) return true;
  return confirm({
    title: t("terminal.close.title", { name }),
    message: t("terminal.close.message", { name }),
    ok: t("terminal.close.terminate"),
  });
}

/** User-initiated Close Tab: confirms first when a command is running. Resolves true if closed. */
export async function requestCloseTab(id: string): Promise<boolean> {
  const tab = useTerminals.getState().tabs.find((x) => x.id === id);
  if (!tab || !(await confirmEndSessions(tab.panes, tabTitle(tab, useTerminals.getState().sessions)))) return false;
  closeTab(id);
  return true;
}

/** User-initiated Close Session (one pane): confirms first when a command is running. */
export async function requestClosePane(key: string): Promise<boolean> {
  const tab = useTerminals.getState().tabs.find((x) => x.panes.includes(key));
  if (!tab || !(await confirmEndSessions([key], tabTitle(tab, useTerminals.getState().sessions)))) return false;
  closePane(key);
  return true;
}

export function closeAll() {
  for (const t of useTerminals.getState().tabs) t.panes.forEach(disposeSession);
  useTerminals.setState({ tabs: [], activeTab: null, sessions: {} });
}

export function selectTab(id: string) {
  useTerminals.setState({ activeTab: id });
}

export function renameTab(id: string, name: string) {
  const trimmed = name.trim();
  useTerminals.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, customName: trimmed || null } : t)),
  }));
}

function setActivePane(tabId: string, key: string) {
  useTerminals.setState((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab || (tab.activePane === key && s.activeTab === tabId)) return s;
    return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePane: key } : t)), activeTab: tabId };
  });
}

export function layoutPanes(node: PaneLayout): string[] {
  return typeof node === "string" ? [node] : node.children.flatMap(layoutPanes);
}

/** Inserts `key` after `target`, nesting a new split (`id`) when the orientation differs from the parent's. */
export function splitLayout(
  node: PaneLayout,
  target: string,
  key: string,
  orientation: SplitOrientation,
  id: string,
): PaneLayout {
  if (typeof node === "string") return node === target ? { id, orientation, children: [node, key] } : node;
  const i = node.children.indexOf(target);
  if (i >= 0 && node.orientation === orientation) {
    return { ...node, children: [...node.children.slice(0, i + 1), key, ...node.children.slice(i + 1)] };
  }
  return { ...node, children: node.children.map((c) => splitLayout(c, target, key, orientation, id)) };
}

/** Removes `key`; splits left with one child collapse into it, and same-orientation children merge up. */
export function removeFromLayout(node: PaneLayout, key: string): PaneLayout | null {
  if (typeof node === "string") return node === key ? null : node;
  const children = node.children
    .map((c) => removeFromLayout(c, key))
    .flatMap((c) => (c === null ? [] : typeof c !== "string" && c.orientation === node.orientation ? c.children : [c]));
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

let splitSeq = 0;

/** Splits the active pane; the new pane opens in its directory. */
export function splitActive(orientation: SplitOrientation): string | null {
  const { tabs, activeTab } = useTerminals.getState();
  const tab = tabs.find((t) => t.id === activeTab);
  if (!tab) return null;
  const current = sessions.get(tab.activePane);
  const session = createSession(current?.state.cwd ?? "/");
  const layout = splitLayout(tab.layout, tab.activePane, session.key, orientation, `g${++splitSeq}`);
  const next = { ...tab, layout, panes: layoutPanes(layout), activePane: session.key };
  useTerminals.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? next : t)) }));
  return session.key;
}

/** Closes one pane; closing the last pane closes the tab. */
export function closePane(key: string) {
  const tab = useTerminals.getState().tabs.find((t) => t.panes.includes(key));
  if (!tab) return;
  if (tab.panes.length === 1) {
    closeTab(tab.id);
    return;
  }
  disposeSession(key);
  const i = tab.panes.indexOf(key);
  const layout = removeFromLayout(tab.layout, key)!;
  const panes = layoutPanes(layout);
  const activePane = tab.activePane === key ? panes[Math.max(0, i - 1)]! : tab.activePane;
  useTerminals.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, layout, panes, activePane } : t)),
  }));
}

export function activeSession(): TerminalSession | undefined {
  const { tabs, activeTab } = useTerminals.getState();
  const tab = tabs.find((t) => t.id === activeTab);
  return tab ? sessions.get(tab.activePane) : undefined;
}

/** Session whose DOM contains `el` (e.g. the focused xterm textarea). */
export function sessionFromElement(el: Element | null): TerminalSession | undefined {
  const host = el?.closest?.<HTMLElement>("[data-terminal-session]");
  const key = host?.dataset.terminalSession;
  return key ? sessions.get(key) : undefined;
}

export function applySettingsToAll() {
  const t = workflowSettings().terminal;
  sessions.forEach((s) => s.applySettings(t));
}

export function applyThemeToAll() {
  sessions.forEach((s) => s.applyTheme());
}

export function publishFocus(focused: boolean) {
  setContext("terminalFocus", focused);
}
