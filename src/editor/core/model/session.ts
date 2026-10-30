/**
 * Editor session per project (IDEA's workspace.xml editor state): open file
 * tabs with pinned / preview flags and the active tab of every pane, the split
 * layout, the active pane and caret / scroll position per file. Tabs of editor
 * kinds that ask for it (`EditorKindContribution.restorable`, like IDEA's
 * FileEditorProvider state) are saved too, as their whole input. Serialised to
 * plain JSON (localStorage, keyed by project root) and rebuilt into a fresh
 * TabsState with new ids.
 */
import { ipcPath } from "@/platform/paths";
import type { EditorInput } from "@/workbench/contributions";
import { initialTabsState, paneIds, type LayoutNode, type Pane, type Tab, type TabsState } from "./tabs";

/** A file tab (`path`), or a tab of a restorable editor kind (`input`, with JSON `data`). */
export interface SessionTab {
  path?: string;
  input?: EditorInput;
  pinned?: boolean;
  preview?: boolean;
}

export type SessionLayout =
  | { kind: "pane"; tabs: SessionTab[]; active: number }
  | { kind: "split"; dir: "row" | "column"; children: SessionLayout[] };

export interface FileViewState {
  anchor: number;
  head: number;
  /** 0-based first visible line. */
  topLine?: number;
}

export interface EditorSession {
  version: 1;
  layout: SessionLayout;
  /** Index of the active pane in visual (depth-first) order. */
  activePane: number;
  files: Record<string, FileViewState>;
}

const STORAGE_PREFIX = "openidea.editorSession.v1:";

const isFileTab = (t: Tab) => t.input.kind === "file" && !!t.input.path;

/** `restorable`: whether a non-file tab is saved (its kind asked for it). */
export function serializeSession(
  s: TabsState,
  files: Record<string, FileViewState>,
  restorable: (input: EditorInput) => boolean = () => false,
): EditorSession | null {
  const saved = (t: Tab) => isFileTab(t) || (t.input.kind !== "file" && restorable(t.input));
  const walk = (n: LayoutNode): SessionLayout | null => {
    if (n.kind === "pane") {
      const pane = s.panes[n.paneId];
      if (!pane) return null;
      const kept = pane.tabs.filter(saved);
      if (!kept.length) return null;
      const active = Math.max(
        0,
        kept.findIndex((t) => t.id === pane.active),
      );
      return {
        kind: "pane",
        tabs: kept.map((t) => ({
          ...(isFileTab(t) ? { path: t.input.path! } : { input: { ...t.input } }),
          ...(t.pinned ? { pinned: true } : {}),
          ...(t.preview ? { preview: true } : {}),
        })),
        active,
      };
    }
    const children = n.children.map(walk).filter((c): c is SessionLayout => !!c);
    if (!children.length) return null;
    return children.length === 1 ? children[0]! : { kind: "split", dir: n.dir, children };
  };
  const layout = walk(s.layout);
  if (!layout) return null;
  // Active pane index among panes that survived serialisation.
  const kept = paneIds(s).filter((id) => s.panes[id]?.tabs.some(saved));
  const activePane = Math.max(0, kept.indexOf(s.activePane));
  const paths = new Set<string>();
  const collect = (l: SessionLayout) =>
    l.kind === "pane" ? l.tabs.forEach((t) => t.path && paths.add(t.path)) : l.children.forEach(collect);
  collect(layout);
  const keptFiles: Record<string, FileViewState> = {};
  for (const p of paths) if (files[p]) keptFiles[p] = files[p]!;
  return { version: 1, layout, activePane, files: keptFiles };
}

/**
 * Windows paths saved before the backend sent `/`-separated paths: `C:\a\b`
 * and `\\?\C:\a\b` become `C:/a/b`. Other paths are returned as is.
 */
export function slashPath(p: string): string {
  return ipcPath(p);
}

function isSessionTab(v: unknown): v is SessionTab {
  if (!v || typeof v !== "object") return false;
  const t = v as SessionTab;
  if (typeof t.path === "string") return !!t.path;
  const i = t.input as Partial<EditorInput> | undefined;
  return !!i && typeof i.kind === "string" && i.kind !== "file" && typeof i.key === "string" && !!i.key;
}

const tabKey = (t: SessionTab) => (t.path !== undefined ? `file:${t.path}` : `input:${t.input!.key}`);

/** Validates untrusted JSON; returns null when unusable. */
export function parseSession(raw: unknown): EditorSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<EditorSession>;
  if (r.version !== 1) return null;
  const check = (l: unknown, depth: number): SessionLayout | null => {
    if (!l || typeof l !== "object" || depth > 16) return null;
    const n = l as SessionLayout;
    if (n.kind === "pane") {
      const tabs = Array.isArray(n.tabs)
        ? n.tabs.filter(isSessionTab).map((t) => (t.path !== undefined ? { ...t, path: slashPath(t.path) } : t))
        : [];
      if (!tabs.length) return null;
      const active = typeof n.active === "number" && n.active >= 0 && n.active < tabs.length ? Math.floor(n.active) : 0;
      return { kind: "pane", tabs, active };
    }
    if (n.kind === "split" && (n.dir === "row" || n.dir === "column") && Array.isArray(n.children)) {
      const children = n.children.map((c) => check(c, depth + 1)).filter((c): c is SessionLayout => !!c);
      if (!children.length) return null;
      return children.length === 1 ? children[0]! : { kind: "split", dir: n.dir, children };
    }
    return null;
  };
  const layout = check(r.layout, 0);
  if (!layout) return null;
  const files: Record<string, FileViewState> = {};
  if (r.files && typeof r.files === "object") {
    for (const [path, v] of Object.entries(r.files)) {
      const f = v as Partial<FileViewState> | null;
      if (f && Number.isInteger(f.anchor) && Number.isInteger(f.head) && f.anchor! >= 0 && f.head! >= 0)
        files[slashPath(path)] = {
          anchor: f.anchor!,
          head: f.head!,
          ...(Number.isInteger(f.topLine) && f.topLine! >= 0 ? { topLine: f.topLine } : {}),
        };
    }
  }
  return {
    version: 1,
    layout,
    activePane: typeof r.activePane === "number" ? Math.max(0, Math.floor(r.activePane)) : 0,
    files,
  };
}

let seq = 0;
const id = (p: string) => `${p}r${++seq}`;

/** Rebuilds a TabsState (fresh ids) from a session. */
export function restoreTabsState(session: EditorSession, fileKey: (path: string) => string): TabsState {
  const panes: Record<string, Pane> = {};
  const order: string[] = [];
  const build = (l: SessionLayout): LayoutNode => {
    if (l.kind === "pane") {
      const paneId = id("pane");
      const seen = new Set<string>();
      const tabs: Tab[] = [];
      let preview = false;
      const byKey = new Map<string, Tab>();
      for (const t of l.tabs) {
        const key = tabKey(t);
        if (seen.has(key)) continue;
        seen.add(key);
        // At most one preview tab per pane; pinned tabs first.
        const isPreview: boolean = !!t.preview && !t.pinned && !preview;
        preview ||= isPreview;
        const input: EditorInput =
          t.path !== undefined ? { kind: "file", key: fileKey(t.path), path: t.path } : { ...t.input! };
        const tab: Tab = { id: id("tab"), input, pinned: !!t.pinned, preview: isPreview };
        byKey.set(key, tab);
        tabs.push(tab);
      }
      tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      const activeTab = l.tabs[l.active];
      const active = (activeTab && byKey.get(tabKey(activeTab))) ?? tabs[0]!;
      panes[paneId] = {
        id: paneId,
        tabs,
        active: active.id,
        mru: [active.id, ...tabs.filter((t) => t !== active).map((t) => t.id)],
      };
      order.push(paneId);
      return { kind: "pane", paneId };
    }
    return { kind: "split", id: id("split"), dir: l.dir, children: l.children.map(build) };
  };
  const layout = build(session.layout);
  if (!order.length) return initialTabsState();
  return { layout, panes, activePane: order[Math.min(session.activePane, order.length - 1)]!, closed: [] };
}

export function loadSession(root: string): EditorSession | null {
  try {
    // Sessions saved under the backslash spelling of a Windows root are picked up too.
    const raw = localStorage.getItem(STORAGE_PREFIX + root) ?? legacyWindowsSession(root);
    return raw ? parseSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function legacyWindowsSession(root: string): string | null {
  if (!/^[A-Za-z]:\//.test(root)) return null;
  const native = root.replace(/\//g, "\\");
  return localStorage.getItem(STORAGE_PREFIX + native) ?? localStorage.getItem(STORAGE_PREFIX + "\\\\?\\" + native);
}

export function storeSession(root: string, session: EditorSession | null) {
  try {
    if (session) localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_PREFIX + root);
  } catch {
    /* storage unavailable */
  }
}
