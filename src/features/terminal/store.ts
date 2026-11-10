/**
 * Terminal tabs and the tab groups the tool window splits into. Tab metadata
 * lives in a zustand store for React; the xterm sessions themselves live in a
 * plain map (they own DOM + PTY).
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import { t } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirm } from "@/workbench/messages";
import { readStored, writeStored, type StoredTerminals } from "./persist";
import { TerminalSession, type SessionOptions, type SessionSnapshot } from "./session";

export type SplitOrientation = "horizontal" | "vertical";

/** A tab group id, or a split of nested layouts. `horizontal` = side by side, `vertical` = stacked. */
export type GroupLayout = string | GroupSplit;
export interface GroupSplit {
  id: string;
  orientation: SplitOrientation;
  children: GroupLayout[];
}

export interface TerminalTab {
  id: string;
  /** Default name ("Local", "Local (2)", or the directory name for "Open in Terminal"). */
  name: string;
  /** Set by the user via rename; wins over `name`. */
  customName: string | null;
  /** Predefined shell program. Absent for the default shell and for one-shot commands. */
  shell: string | null;
  /** Key of the tab's session. */
  session: string;
  /** The tab group showing it. */
  group: string;
}

interface TerminalState {
  /** Every tab, in tab strip order within its group. */
  tabs: TerminalTab[];
  /**
   * The tab groups the tool window is split into (IDEA's Split Right / Split
   * Down), each with its own tab strip.
   */
  layout: GroupLayout;
  /** The selected tab of each group. */
  selected: Record<string, string>;
  /** The selected tab of the group used last; the one New Tab, Split and Find act on. */
  activeTab: string | null;
  sessions: Record<string, SessionSnapshot>;
}

let groupSeq = 0;
const newGroupId = () => `g${++groupSeq}`;

export const useTerminals = create<TerminalState>(() => ({
  tabs: [],
  layout: newGroupId(),
  selected: {},
  activeTab: null,
  sessions: {},
}));

const sessions = new Map<string, TerminalSession>();
let seq = 0;

export function getSession(key: string): TerminalSession | undefined {
  return sessions.get(key);
}

export function allSessions(): TerminalSession[] {
  return [...sessions.values()];
}

/** Refits every live session. The terminal tool window calls this when it gains a box. */
export function refitSessions() {
  for (const session of sessions.values()) session.refit();
}

export function sessionForTerminalId(id: number): TerminalSession | undefined {
  return allSessions().find((s) => s.terminalId === id);
}

function createSession(cwd: string, command?: SessionOptions["command"], fallbackRoot?: string): TerminalSession {
  const key = `s${++seq}`;
  const session = new TerminalSession({
    key,
    cwd,
    command,
    fallbackRoot,
    onChange: (k, snapshot) => useTerminals.setState((s) => ({ sessions: { ...s.sessions, [k]: snapshot } })),
    onFocus: (k) => {
      const tab = tabOfSession(k);
      if (tab) selectTab(tab.id);
    },
    onExit: (k) => {
      const tab = tabOfSession(k);
      if (tab && workflowSettings().terminal.closeOnExit) closeTab(tab.id);
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

/** The title the program in the tab set, while a command runs (at the prompt it is the shell's own). */
function appTitle(tab: TerminalTab, sessions?: Record<string, SessionSnapshot>): string | null {
  const s = sessions?.[tab.session];
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

/** The tabs of `group`, in strip order. */
export function groupTabs(tabs: readonly TerminalTab[], group: string): TerminalTab[] {
  return tabs.filter((t) => t.group === group);
}

function tabOfSession(key: string): TerminalTab | undefined {
  return useTerminals.getState().tabs.find((t) => t.session === key);
}

function defaultTabName(base = workflowSettings().terminal.tabName): string {
  return nextTabName(
    useTerminals.getState().tabs.map((t) => t.name),
    base,
  );
}

/** Opens a tab in the active tab's group. */
export function newTab(cwd: string, name?: string, command?: SessionOptions["command"]): TerminalTab {
  const session = createSession(cwd, command);
  const { tabs, layout, activeTab } = useTerminals.getState();
  const tab: TerminalTab = {
    id: `t${seq}`,
    name: defaultTabName(name),
    customName: null,
    shell: command?.shell ? command.program : null,
    session: session.key,
    group: tabs.find((t) => t.id === activeTab)?.group ?? layoutGroups(layout)[0]!,
  };
  useTerminals.setState((s) => ({
    tabs: [...s.tabs, tab],
    selected: { ...s.selected, [tab.group]: tab.id },
    activeTab: tab.id,
  }));
  return tab;
}

export function newTabAt(dir: string): TerminalTab {
  return newTab(dir, basename(dir) || "Local");
}

type Placement = Pick<TerminalState, "tabs" | "layout" | "selected" | "activeTab">;

/**
 * `s` without tab `id`. Its group selects the neighbouring tab or, left empty,
 * leaves the split (the last group stays); an active tab passes to the group's
 * new selection, else to the neighbouring group's.
 */
function withoutTab(s: Placement, id: string): Placement {
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return s;
  const siblings = groupTabs(s.tabs, tab.group);
  const rest = siblings.filter((t) => t.id !== id);
  const selected = { ...s.selected };
  let layout = s.layout;
  let heir: string | null = null;
  if (rest.length > 0) {
    if (selected[tab.group] === id) selected[tab.group] = rest[Math.min(siblings.indexOf(tab), rest.length - 1)]!.id;
    heir = tab.group;
  } else {
    delete selected[tab.group];
    if (typeof layout !== "string") {
      heir = neighbourGroup(layout, tab.group);
      layout = removeFromLayout(layout, tab.group)!;
    }
  }
  return {
    tabs: s.tabs.filter((t) => t.id !== id),
    layout,
    selected,
    activeTab: s.activeTab === id ? ((heir && selected[heir]) ?? null) : s.activeTab,
  };
}

export function closeTab(id: string) {
  const tab = useTerminals.getState().tabs.find((t) => t.id === id);
  if (!tab) return;
  disposeSession(tab.session);
  useTerminals.setState((s) => withoutTab(s, id));
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
  if (!tab || !(await confirmEndSessions([tab.session], tabTitle(tab, useTerminals.getState().sessions)))) return false;
  closeTab(id);
  return true;
}

/** User-initiated Close Session: closes the session's tab, confirming first when a command is running. */
export function requestCloseSession(key: string): Promise<boolean> {
  const tab = tabOfSession(key);
  return tab ? requestCloseTab(tab.id) : Promise.resolve(false);
}

export function closeAll() {
  for (const t of useTerminals.getState().tabs) disposeSession(t.session);
  useTerminals.setState({ tabs: [], layout: newGroupId(), selected: {}, activeTab: null, sessions: {} });
}

/** Selects tab `id` in its group and makes it the active tab. */
export function selectTab(id: string) {
  useTerminals.setState((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab || (s.activeTab === id && s.selected[tab.group] === id)) return s;
    return { selected: { ...s.selected, [tab.group]: id }, activeTab: id };
  });
}

/** Makes `group`'s selected tab the active one, for actions run from the group's header. */
export function activateGroup(group: string) {
  const id = useTerminals.getState().selected[group];
  if (id) selectTab(id);
}

/** `tabs` with tab `id` moved to insertion `index`, an index into `tabs` before the move. */
export function reorderTabs<T extends { id: string }>(tabs: readonly T[], id: string, index: number): T[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return [...tabs];
  const rest = tabs.filter((t) => t.id !== id);
  rest.splice(Math.max(0, Math.min(index > from ? index - 1 : index, rest.length)), 0, tabs[from]!);
  return rest;
}

export function renameTab(id: string, name: string) {
  const trimmed = name.trim();
  useTerminals.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, customName: trimmed || null } : t)),
  }));
}

export function layoutGroups(node: GroupLayout): string[] {
  return typeof node === "string" ? [node] : node.children.flatMap(layoutGroups);
}

/** Inserts `key` after `target` (or `before` it), nesting a new split (`id`) when the orientation differs from the parent's. */
export function splitLayout(
  node: GroupLayout,
  target: string,
  key: string,
  orientation: SplitOrientation,
  id: string,
  before = false,
): GroupLayout {
  if (typeof node === "string")
    return node === target ? { id, orientation, children: before ? [key, node] : [node, key] } : node;
  const i = node.children.indexOf(target);
  if (i >= 0 && node.orientation === orientation) {
    const at = before ? i : i + 1;
    return { ...node, children: [...node.children.slice(0, at), key, ...node.children.slice(at)] };
  }
  return { ...node, children: node.children.map((c) => splitLayout(c, target, key, orientation, id, before)) };
}

/** Removes `key`; splits left with one child collapse into it, and same-orientation children merge up. */
export function removeFromLayout(node: GroupLayout, key: string): GroupLayout | null {
  if (typeof node === "string") return node === key ? null : node;
  const children = node.children
    .map((c) => removeFromLayout(c, key))
    .flatMap((c) => (c === null ? [] : typeof c !== "string" && c.orientation === node.orientation ? c.children : [c]));
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

/** The group beside `group` in its split (the one before it, else after); null when not split. */
export function neighbourGroup(node: GroupLayout, group: string): string | null {
  if (typeof node === "string") return null;
  const i = node.children.indexOf(group);
  if (i > 0) return layoutGroups(node.children[i - 1]!).at(-1)!;
  if (i === 0) return layoutGroups(node.children[1]!)[0]!;
  for (const child of node.children) {
    const found = neighbourGroup(child, group);
    if (found) return found;
  }
  return null;
}

/** The group in the top right corner, whose header has the tool window's buttons. */
export function topRightGroup(node: GroupLayout): string {
  if (typeof node === "string") return node;
  return topRightGroup((node.orientation === "horizontal" ? node.children.at(-1) : node.children[0])!);
}

let splitSeq = 0;

/**
 * Split Right / Split Down, as IDEA: a new tab group beside tab `id`'s, with a
 * new session in its directory, or with `move` (Split and Move) the tab itself,
 * which needs another tab to stay behind. Returns the new group's tab.
 */
export function splitTab(id: string, orientation: SplitOrientation, move = false): string | null {
  const s = useTerminals.getState();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab || (move && groupTabs(s.tabs, tab.group).length < 2)) return null;
  const group = newGroupId();
  const layout = splitLayout(s.layout, tab.group, group, orientation, `split${++splitSeq}`);
  if (move) {
    const rest = withoutTab(s, id);
    useTerminals.setState({
      tabs: [...rest.tabs, { ...tab, group }],
      layout,
      selected: { ...rest.selected, [group]: id },
      activeTab: id,
    });
    return id;
  }
  const session = createSession(sessions.get(tab.session)?.state.cwd ?? "/", undefined, boundProject ?? undefined);
  const copy: TerminalTab = {
    id: `t${seq}`,
    name: defaultTabName(),
    customName: null,
    shell: null,
    session: session.key,
    group,
  };
  useTerminals.setState((st) => ({
    tabs: [...st.tabs, copy],
    layout,
    selected: { ...st.selected, [group]: copy.id },
    activeTab: copy.id,
  }));
  return copy.id;
}

/** Unsplit: merges `group`'s tabs into the group beside it, keeping its selected tab. */
export function unsplit(group: string) {
  useTerminals.setState((s) => {
    const into = neighbourGroup(s.layout, group);
    if (!into) return s;
    const keep = s.selected[group] ?? s.selected[into]!;
    const selected = { ...s.selected, [into]: keep };
    delete selected[group];
    return {
      // In layout order, so the merged strip keeps the tabs left to right / top to bottom.
      tabs: layoutGroups(s.layout)
        .flatMap((g) => groupTabs(s.tabs, g))
        .map((t) => (t.group === group ? { ...t, group: into } : t)),
      layout: removeFromLayout(s.layout, group)!,
      selected,
      activeTab: keep,
    };
  });
}

/**
 * Drag & drop: moves tab `id` to insertion `index` of `group`'s strip. Within
 * its own group that reorders it; into another it also becomes the selected tab.
 */
export type SplitEdge = "left" | "right" | "top" | "bottom";

/**
 * Drag & drop: tab `id` dropped on an edge of `group`'s terminal becomes a new group
 * on that side, like an editor tab dropped on the edge of a pane. A group's only tab
 * dropped on its own edge stays: there is nothing to split off from.
 */
export function moveTabToSplit(id: string, group: string, edge: SplitEdge): boolean {
  const s = useTerminals.getState();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab || !layoutGroups(s.layout).includes(group)) return false;
  if (tab.group === group && groupTabs(s.tabs, group).length < 2) return false;
  const rest = withoutTab(s, id);
  const target = newGroupId();
  const orientation: SplitOrientation = edge === "left" || edge === "right" ? "horizontal" : "vertical";
  useTerminals.setState({
    tabs: [...rest.tabs, { ...tab, group: target }],
    layout: splitLayout(
      rest.layout,
      group,
      target,
      orientation,
      `split${++splitSeq}`,
      edge === "left" || edge === "top",
    ),
    selected: { ...rest.selected, [target]: id },
    activeTab: id,
  });
  return true;
}

/**
 * Where a tab dropped on the middle of a group (its terminal, or the header's empty
 * part) lands: at the end, like an editor tab dropped on a pane; `null` when it is
 * already in that group, so a sloppy release doesn't reorder it.
 */
export function groupDropIndex(tabs: readonly TerminalTab[], id: string, group: string): number | null {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.group === group) return null;
  return groupTabs(tabs, group).length;
}

export function moveTab(id: string, group: string, index: number) {
  useTerminals.setState((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab || !layoutGroups(s.layout).includes(group)) return s;
    const others = (tabs: readonly TerminalTab[]) => tabs.filter((t) => t.group !== group);
    if (tab.group === group) return { tabs: [...others(s.tabs), ...reorderTabs(groupTabs(s.tabs, group), id, index)] };
    const rest = withoutTab(s, id);
    const strip = groupTabs(rest.tabs, group);
    strip.splice(Math.max(0, Math.min(index, strip.length)), 0, { ...tab, group });
    return {
      tabs: [...others(rest.tabs), ...strip],
      layout: rest.layout,
      selected: { ...rest.selected, [group]: id },
      activeTab: id,
    };
  });
}

export function activeSession(): TerminalSession | undefined {
  const { tabs, activeTab } = useTerminals.getState();
  const tab = tabs.find((t) => t.id === activeTab);
  return tab ? sessions.get(tab.session) : undefined;
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

/** Project whose tabs `useTerminals` currently holds. Null before the first bind and after unbind. */
let boundProject: string | null = null;
/** Set while swapping projects, so closing the old tabs is not saved as the new project's layout. */
let restoring = false;

function sessionCwd(key: string): string {
  return sessions.get(key)?.state.cwd ?? "";
}

function capture(): StoredTerminals {
  const s = useTerminals.getState();
  const tabs = s.tabs.flatMap((t) => {
    const cwd = sessionCwd(t.session);
    return cwd ? [{ id: t.id, name: t.name, customName: t.customName, cwd, group: t.group, shell: t.shell }] : [];
  });
  return { v: 1, tabs, layout: s.layout, selected: s.selected, activeTab: s.activeTab };
}

function remember() {
  if (restoring || !boundProject) return;
  writeStored(boundProject, capture());
}

function cwdSignature(s: TerminalState): string {
  return s.tabs.map((t) => s.sessions[t.session]?.cwd ?? "").join("\n");
}

useTerminals.subscribe((s, prev) => {
  if (restoring || !boundProject) return;
  if (
    s.tabs === prev.tabs &&
    s.layout === prev.layout &&
    s.selected === prev.selected &&
    s.activeTab === prev.activeTab &&
    cwdSignature(s) === cwdSignature(prev)
  ) {
    return;
  }
  remember();
});

function remapLayout(node: GroupLayout, mapGroup: (group: string) => string): GroupLayout {
  if (typeof node === "string") return mapGroup(node);
  return {
    id: `split${++splitSeq}`,
    orientation: node.orientation,
    children: node.children.map((child) => remapLayout(child, mapGroup)),
  };
}

/** Opens the saved tabs in fresh sessions. Group ids are new, so they don't collide with ones minted later. */
function restore(saved: StoredTerminals, root: string) {
  const groupOf = new Map<string, string>();
  const mapGroup = (group: string) => {
    let mapped = groupOf.get(group);
    if (!mapped) groupOf.set(group, (mapped = newGroupId()));
    return mapped;
  };
  const layout = remapLayout(saved.layout, mapGroup);
  const idOf = new Map<string, string>();
  const tabs: TerminalTab[] = [];
  for (const savedTab of saved.tabs) {
    const session = createSession(
      savedTab.cwd,
      savedTab.shell ? { program: savedTab.shell, args: [], shell: true } : undefined,
      // A saved directory may have been deleted since the last run: start in the project root then.
      root,
    );
    const id = `t${seq}`;
    idOf.set(savedTab.id, id);
    tabs.push({
      id,
      name: savedTab.name,
      customName: savedTab.customName,
      shell: savedTab.shell,
      session: session.key,
      group: mapGroup(savedTab.group),
    });
  }
  const selected: Record<string, string> = {};
  for (const group of layoutGroups(layout)) {
    const savedGroup = [...groupOf.entries()].find(([, mapped]) => mapped === group)?.[0];
    const wanted = savedGroup ? idOf.get(saved.selected[savedGroup] ?? "") : undefined;
    const inGroup = tabs.filter((t) => t.group === group);
    const id = (wanted && inGroup.some((t) => t.id === wanted) ? wanted : inGroup[0]?.id) ?? "";
    if (id) selected[group] = id;
  }
  const activeTab = (saved.activeTab && idOf.get(saved.activeTab)) || tabs[0]?.id || null;
  useTerminals.setState({ tabs, layout, selected, activeTab });
}

/**
 * Points the terminal at `root`, remembering the project it was bound to.
 * The same root again is a no-op, so a tool window re-render doesn't reopen tabs.
 */
export function syncTerminalProject(root: string | null) {
  if (root === boundProject) return;
  if (boundProject) writeStored(boundProject, capture());
  restoring = true;
  boundProject = root;
  try {
    closeAll();
    if (!root) return;
    const saved = readStored(root);
    if (saved?.tabs.length) restore(saved, root);
  } finally {
    restoring = false;
  }
}

/** Drops the in-memory sessions without writing the empty layout over the project that owned them. */
export function unbindTerminals() {
  if (boundProject) writeStored(boundProject, capture());
  restoring = true;
  boundProject = null;
  try {
    closeAll();
  } finally {
    restoring = false;
  }
}

const pluginSessions = new Map<string, string>();

/** Host-authorized plugin sessions use the same tabs and PTY controls as user terminals. */
export async function pluginSession(a: {
  kind: "terminal";
  operation: string;
  title?: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  spawn?: NonNullable<SessionOptions["command"]>["spawn"];
  onExit: (code: number | null, closed: boolean) => void;
}) {
  const tab = useTerminals.getState().tabs.find((t) => t.id === pluginSessions.get(a.operation));
  const session = tab && getSession(tab.session);
  if (session && session.state.status === "running") {
    selectTab(tab.id);
    return;
  }
  if (!a.cwd || !a.program) throw new Error("Invalid terminal request");
  const created = newTab(a.cwd, a.title, {
    program: a.program,
    args: a.args ?? [],
    env: a.env,
    spawn: a.spawn,
    onExit: (code, closed) => {
      pluginSessions.delete(a.operation);
      a.onExit(code, closed);
    },
  });
  pluginSessions.set(a.operation, created.id);
  const started = getSession(created.session)!;
  await started.start();
  if (started.state.status === "error") {
    closeTab(created.id);
    pluginSessions.delete(a.operation);
    throw new Error("Terminal did not start");
  }
}
