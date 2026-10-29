/**
 * Editor controller: tabs/splits store, editor slots, focus + context keys,
 * status, navigation history, autosave. The React views and actions talk to
 * this singleton; other features use the EditorService and editor/api.
 */
import { EditorSelection } from "@codemirror/state";
import { create } from "zustand";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { basename, useProject } from "@/platform/project";
import { editorPrefs } from "@/platform/editorSettings";
import {
  _emitEditorEvent,
  _provideNavigationHistory,
  _provideOpenEditorPaths,
  _setActiveEditor,
  type NavigationLocation,
} from "@/editor/api";
import {
  getFileDecoration,
  menuGroupItems,
  notifications,
  resolveFileEditor,
  useContributions,
  type EditorCloseSession,
  type EditorInput,
  type OpenOptions,
  type FileEditorResolution,
  type OpenEditorTab,
} from "@/workbench/contributions";
import { useDistractionFree } from "@/workbench/distractionFree";
import { ask } from "@/workbench/messages";
import { t } from "@/platform/i18n";
import { fileIconName, showContextMenu, type MenuItem } from "@/ui";
import { usePlatform } from "@/platform/platformInfo";
import {
  activateTab,
  changeSplitOrientation,
  closeAll,
  closeKey,
  closeOthers,
  closeTab,
  closeToLeft,
  closeToRight,
  closeUnmodified,
  cycleTab,
  enforceTabLimit,
  findTab,
  initialTabsState,
  moveTab,
  moveTabToNewSplit,
  neighbourPane,
  openKeys,
  openTab,
  paneIds,
  paneOf,
  promoteTab,
  removePane,
  reopenClosed,
  setActivePane,
  splitAtEdge,
  sortTabs,
  splitPane,
  tabOptions,
  togglePin,
  unsplitAll,
  type SplitEdge,
  type Tab,
  type TabsState,
} from "./model/tabs";
import { DocumentManager, useDocMeta } from "./model/document";
import {
  closedDocuments,
  combinedError,
  customDocuments,
  documentDirty,
  documentLifecycle,
  failures,
  inputDirty,
  type CustomDocument,
} from "./model/customDocuments";
import { EditorSlot, type SlotHost } from "./model/slot";
import { NavigationHistory } from "./model/navHistory";
import { EditHistory } from "./model/editHistory";
import { loadSession, restoreTabsState, serializeSession, storeSession, type FileViewState } from "./model/session";
import { docBackend, type DocBackend } from "./backend";
import { isVirtualUri, virtualDocument } from "@/platform/virtualDocs";
import type { VirtualDocument } from "@/platform/ipc";
import type { Scheduler } from "./sync/DocSync";

export const fileKey = (path: string) => `file:${path}`;
export const fileInput = (path: string): EditorInput => ({ kind: "file", key: fileKey(path), path });

/** `data` of a `virtual` editor input: what the tab and its notice show. */
export interface VirtualInputData {
  title: string;
  description: string | null;
  decompiled: boolean;
}

export const virtualKey = (uri: string) => `virtual:${uri}`;
/**
 * A read-only virtual document (library class from a language server). Its
 * `path` is the URI, which also identifies its document model.
 */
export const virtualInput = (
  vd: Pick<VirtualDocument, "uri" | "title" | "description" | "decompiled">,
): EditorInput => ({
  kind: "virtual",
  key: virtualKey(vd.uri),
  path: vd.uri,
  data: { title: vd.title, description: vd.description, decompiled: vd.decompiled } satisfies VirtualInputData,
});

/** Inputs shown in the text editor: files and virtual documents. */
export function isTextInput(input: EditorInput): input is EditorInput & { path: string } {
  return (input.kind === "file" || input.kind === "virtual") && !!input.path;
}

export const useTabs = create<TabsState>(() => initialTabsState());

/** Session key of the LightEdit window: its tabs reopen the next time a window switches to LightEdit. */
export const LIGHT_EDIT_SESSION = "<lightEdit>";

export interface EditorStatus {
  path: string;
  doc: number;
  /** 0-based */
  line: number;
  col: number;
  offset: number;
  selectedChars: number;
  selectedLines: number;
  carets: number;
}

export const useEditorStatus = create<{ status: EditorStatus | null }>(() => ({ status: null }));
/** Per-tab open errors (file missing, too large…). */
export const useTabErrors = create<Record<string, string>>(() => ({}));
/** Per-pane find bar state (open / replace mode); the bar keeps its own query. */
export const useFindBars = create<Record<string, { replace: boolean; seq: number } | undefined>>(() => ({}));
export const useGotoLine = create<{ open: boolean }>(() => ({ open: false }));

/** Paths of open file tabs, all panes in visual order, unique. */
export function openFilePaths(s: TabsState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of paneIds(s))
    for (const t of s.panes[id]?.tabs ?? [])
      if (t.input.kind === "file" && t.input.path && !seen.has(t.input.path)) {
        seen.add(t.input.path);
        out.push(t.input.path);
      }
  return out;
}

/** Editor Tabs › Sort tabs alphabetically: by file name. */
function tabSortKey(input: EditorInput): string {
  return basename(input.path ?? input.key);
}

function isTextTab(tab: Tab | null | undefined): tab is Tab & { input: { path: string } } {
  return !!tab && isTextInput(tab.input);
}

type EditorKinds = ReturnType<typeof useContributions.getState>["editorKinds"];

/** Tab title of an editor input: the file name, or what its editor kind calls it. */
export function tabTitle(input: EditorInput, kinds: EditorKinds): string {
  if (input.kind === "file") return basename(input.path ?? input.key);
  if (input.kind === "virtual")
    return (input.data as VirtualInputData | undefined)?.title ?? basename(input.path ?? input.key);
  const kind = kinds.get(input.kind);
  try {
    return kind?.title(input) ?? input.key;
  } catch {
    return input.key;
  }
}

export function tabIcon(input: EditorInput, kinds: EditorKinds): string {
  if (input.kind === "file") return fileIconName(basename(input.path ?? ""));
  if (input.kind === "virtual") return fileIconName(tabTitle(input, kinds));
  const kind = kinds.get(input.kind);
  try {
    return kind?.icon?.(input) ?? "file";
  } catch {
    return "file";
  }
}

export class EditorController implements SlotHost {
  manager: DocumentManager;
  readonly slots = new Map<string, EditorSlot>();
  private pending = new Map<string, Promise<EditorSlot | null>>();
  readonly nav = new NavigationHistory();
  readonly edits = new EditHistory();
  private navSuppress = 0;
  activeSlot: EditorSlot | null = null;
  private statusScheduled = false;
  private disposers: Array<() => void> = [];
  /** Project root (or {@link LIGHT_EDIT_SESSION}) whose editor session is being tracked (null while switching). */
  private sessionRoot: string | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;
  /** Restored caret / scroll per path, applied when the file's first slot is created. */
  private restoredViews = new Map<string, FileViewState>();
  /** Tabs created by session restore; dropped silently if their file is gone. */
  private restoredTabs = new Set<string>();
  /** When each input key was last the active tab (a counter, across panes). */
  private lastActive = new Map<string, number>();
  private activeClock = 0;
  /** Serializes close decisions without retaining a stale tabs snapshot. */
  private removalTail: Promise<unknown> = Promise.resolve();
  private closingDocuments = new Map<string, Promise<void>>();
  private preparedDocuments = new Map<string, CustomDocument>();
  private closeSession: EditorCloseSession | null = null;
  private closeCommitted = false;
  private projectGeneration = 0;
  private admissionGeneration = 0;
  private closeRequests = 0;
  private projectTransition: Promise<void> = Promise.resolve();

  constructor(backend: DocBackend = docBackend(), scheduler?: Scheduler) {
    this.manager = new DocumentManager(
      backend,
      {
        settings: () => useProject.getState().settings ?? useProject.getState().project?.settings,
        notify: (n) => notifications().notify(n),
      },
      scheduler,
    );
  }

  start() {
    this.manager.start();
    _provideNavigationHistory(() => this.nav.snapshot());
    _provideOpenEditorPaths(() => openFilePaths(useTabs.getState()));
    let prevTabs = useTabs.getState();
    this.disposers.push(
      useTabs.subscribe((s) => {
        const prev = prevTabs;
        prevTabs = s;
        this.stampActive(s);
        this.onTabsChanged(prev, s);
      }),
    );
    tabOptions.activateOnClose = editorPrefs().tabs.activateOnClose as typeof tabOptions.activateOnClose;
    let prevSettings = useProject.getState().settings;
    let prevRoot = useProject.getState().project?.root ?? null;
    let prevLight = useProject.getState().lightEdit;
    this.disposers.push(
      useProject.subscribe((s, previous) => {
        if (s.settings !== prevSettings) {
          prevSettings = s.settings;
          tabOptions.activateOnClose = editorPrefs(s.settings).tabs
            .activateOnClose as typeof tabOptions.activateOnClose;
          this.manager.applySettings();
        }
        const root = s.project?.root ?? null;
        // Entering or leaving LightEdit replaces the backend's documents too.
        if (root !== prevRoot || s.lightEdit !== prevLight || (s.opening && s.project !== previous.project)) {
          prevRoot = root;
          prevLight = s.lightEdit;
          this.saveSession();
          this.sessionRoot = null;
          const generation = ++this.projectGeneration;
          const documents = customDocuments(useTabs.getState(), useContributions.getState().editorKinds);
          // The guard decided already. Disposal must never prompt or autosave
          // custom documents after the backend has replaced their project.
          useTabs.setState(initialTabsState(), true);
          this.closeSession = null;
          this.closeCommitted = false;
          this.preparedDocuments.clear();
          this.nav.clear();
          this.edits.clear();
          this.restoredTabs.clear();
          this.restoredViews.clear();
          this.projectTransition = this.releaseDocuments(documents.values())
            .catch((e) => this.documentError(e))
            .then(() => {
              if (generation !== this.projectGeneration) return;
              if (root) this.restoreSession(root);
              else if (s.lightEdit) this.restoreSession(LIGHT_EDIT_SESSION);
            });
        } else if (previous.opening && !s.opening && this.closeCommitted) {
          // A failed project open returns to the same project.
          this.closeSession?.cancel();
        }
      }),
    );
    // Gutter, centred column and sticky lines follow Distraction Free Mode.
    this.disposers.push(useDistractionFree.subscribe(() => this.manager.applySettings()));
    if (prevRoot) this.restoreSession(prevRoot);
    if (this.manager.backend.onFsChanged)
      this.disposers.push(this.manager.backend.onFsChanged((e) => this.onFilesRemoved(e.removed)));
    const onWindowBlur = () => {
      if (this.autoSave() && !this.closeSession) {
        void this.manager.saveAll("auto");
        void this.saveCustomDocuments(true).catch((e) => this.documentError(e));
      }
    };
    const onPageHide = () => this.saveSession();
    if (typeof window !== "undefined") {
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onPageHide);
      this.disposers.push(() => {
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onPageHide);
      });
    }
    this.publishContext();
  }

  stop() {
    this.saveSession();
    this.sessionRoot = null;
    ++this.projectGeneration;
    clearTimeout(this.sessionTimer);
    const documents = customDocuments(useTabs.getState(), useContributions.getState().editorKinds);
    this.disposers.splice(0).forEach((d) => d());
    this.closeSession = null;
    this.closeCommitted = false;
    this.preparedDocuments.clear();
    for (const slot of this.slots.values()) slot.dispose();
    this.slots.clear();
    this.manager.stop();
    useTabs.setState(initialTabsState(), true);
    void this.releaseDocuments(documents.values()).catch((e) => this.documentError(e));
  }

  autoSave(): boolean {
    return this.manager.settings()?.files?.autoSave !== false;
  }

  // --- tab store reactions -------------------------------------------------

  private onTabsChanged(prev: TabsState, next: TabsState) {
    const live = new Set<string>();
    for (const p of Object.values(next.panes)) for (const t of p.tabs) live.add(t.id);
    for (const [id, slot] of this.slots) {
      if (!live.has(id)) {
        this.slots.delete(id);
        if (this.activeSlot === slot) this.setActiveSlot(null);
        slot.dispose();
      }
    }
    for (const id of Object.keys(useTabErrors.getState()))
      if (!live.has(id))
        useTabErrors.setState((s) => {
          const n = { ...s };
          delete n[id];
          return n;
        }, true);

    // Save only a document that remains open. A discarded/closing document must
    // never be saved by the tab removal that follows its close decision.
    if (this.autoSave() && !this.closeSession) {
      const saved = new Set<string>();
      const open = openKeys(next);
      for (const [paneId, pane] of Object.entries(prev.panes)) {
        const now = next.panes[paneId];
        if (pane.active && now && now.active !== pane.active) {
          const slot = this.slots.get(pane.active);
          if (slot) void slot.model.save("auto").catch(() => {});
          const input = pane.tabs.find((t) => t.id === pane.active)?.input;
          if (input && open.has(input.key) && !saved.has(input.key) && !this.preparedDocuments.has(input.key)) {
            saved.add(input.key);
            const lifecycle = documentLifecycle(input, useContributions.getState().editorKinds);
            if (lifecycle && documentDirty({ input, lifecycle }))
              void lifecycle.save(input).catch((e) => this.documentError(e));
          }
        }
      }
    }

    // Active editor follows the active pane's active tab.
    const tab = this.activeTabOf(next);
    const slot = tab && isTextTab(tab) ? (this.slots.get(tab.id) ?? null) : null;
    if (slot !== this.activeSlot) this.setActiveSlot(slot, tab);
    this.publishContext();
    for (const id of this.restoredTabs) if (!live.has(id)) this.restoredTabs.delete(id);
    this.scheduleSessionSave();
  }

  // --- session (open tabs, splits, carets per project) ---------------------------

  private scheduleSessionSave() {
    if (!this.sessionRoot) return;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.saveSession(), 400);
  }

  /** Writes the editor session of the tracked project now. */
  saveSession() {
    clearTimeout(this.sessionTimer);
    const root = this.sessionRoot;
    if (!root) return;
    const files: Record<string, FileViewState> = Object.fromEntries(this.restoredViews);
    for (const slot of this.slots.values()) {
      if (slot.disposed) continue;
      const path = slot.model.path;
      // The last focused slot of a document wins over other split copies.
      if (files[path] && slot.model.lastFocused !== slot && !this.restoredViews.has(path)) continue;
      files[path] = slot.viewState();
    }
    const kinds = useContributions.getState().editorKinds;
    storeSession(
      root,
      serializeSession(useTabs.getState(), files, (input) => !!kinds.get(input.kind)?.restorable),
    );
  }

  /** Reopens the tabs, splits and carets saved for `root` (after the project opened). */
  restoreSession(root: string) {
    this.sessionRoot = root;
    const session = loadSession(root);
    if (!session) return;
    const state = restoreTabsState(session, fileKey);
    const kinds = useContributions.getState().editorKinds;
    for (const pane of Object.values(state.panes))
      pane.tabs = pane.tabs.map((tab) => (documentLifecycle(tab.input, kinds) ? { ...tab, preview: false } : tab));
    this.restoredViews = new Map(Object.entries(session.files));
    this.restoredTabs = new Set(Object.values(state.panes).flatMap((p) => p.tabs.map((t) => t.id)));
    useTabs.setState(state, true);
    for (const pane of Object.values(state.panes)) if (pane.active) void this.ensureSlot(pane.active);
  }

  private activeTabOf(s: TabsState = useTabs.getState()): Tab | null {
    const pane = s.panes[s.activePane];
    return pane?.tabs.find((t) => t.id === pane.active) ?? null;
  }

  // --- slots -------------------------------------------------------------------

  locateTab(tabId: string): { paneId: string; tab: Tab } | null {
    const s = useTabs.getState();
    for (const [paneId, p] of Object.entries(s.panes)) {
      const tab = p.tabs.find((t) => t.id === tabId);
      if (tab) return { paneId, tab };
    }
    return null;
  }

  slotFor(tabId: string): EditorSlot | null {
    return this.slots.get(tabId) ?? null;
  }

  /** Creates the slot of a file tab (opening its document) if needed. */
  ensureSlot(tabId: string, init?: { from?: EditorSlot }): Promise<EditorSlot | null> {
    const existing = this.slots.get(tabId);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(tabId);
    if (pending) return pending;
    const loc = this.locateTab(tabId);
    if (!loc || !isTextTab(loc.tab)) return Promise.resolve(null);
    const path = loc.tab.input.path;
    const model = this.manager.get(path);
    if (model) return Promise.resolve(this.createSlot(tabId, model, init));
    const p = this.manager
      .acquire(path)
      .then((m) => {
        if (!this.locateTab(tabId)) {
          this.manager.release(m);
          return null;
        }
        return this.slots.get(tabId) ?? this.createSlot(tabId, m, init);
      })
      .catch((e: unknown) => {
        if (this.restoredTabs.has(tabId) && (e as { kind?: string } | null)?.kind === "notFound") {
          // A file from the saved session no longer exists: drop its tab quietly.
          this.restoredTabs.delete(tabId);
          this.restoredViews.delete(path);
          const loc = this.locateTab(tabId);
          if (loc) this.apply((st) => (st.panes[loc.paneId] ? closeTab(st, loc.paneId, tabId) : st));
          return null;
        }
        const message = e instanceof Error ? e.message : String(e);
        useTabErrors.setState({ [tabId]: message });
        return null;
      })
      .finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, p);
    return p;
  }

  private createSlot(tabId: string, model: import("./model/document").DocModel, init?: { from?: EditorSlot }) {
    // Copy caret/scroll from another slot of the same document when splitting.
    const from = init?.from ?? undefined;
    const slot = new EditorSlot(model, tabId, this, { from });
    this.slots.set(tabId, slot);
    const restored = this.restoredViews.get(model.path);
    if (restored && !from) {
      this.restoredViews.delete(model.path);
      slot.restoreView(restored);
    }
    this.restoredTabs.delete(tabId);
    const active = this.activeTabOf();
    if (active?.id === tabId) this.setActiveSlot(slot);
    return slot;
  }

  /** Called by the view host after mounting. */
  onMounted(slot: EditorSlot) {
    const active = this.activeTabOf();
    if (active?.id === slot.tabId) this.setActiveSlot(slot);
    if (slot.wantsFocus) {
      slot.wantsFocus = false;
      requestAnimationFrame(() => slot.focus());
    }
  }

  private setActiveSlot(slot: EditorSlot | null, nonTextTab: Tab | null = null) {
    const changed = slot !== this.activeSlot;
    this.activeSlot = slot;
    _setActiveEditor(slot?.handle ?? null);
    if (changed) {
      _emitEditorEvent({
        type: "activeEditorChanged",
        path: slot?.model.path ?? nonTextTab?.input.path ?? null,
        doc: slot?.model.doc ?? null,
      });
      if (slot) this.recordNav(slot, true);
    }
    this.scheduleStatus();
  }

  // --- SlotHost ------------------------------------------------------------------

  onFocus(slot: EditorSlot) {
    slot.model.lastFocused = slot;
    const loc = this.locateTab(slot.tabId);
    if (loc) {
      const s = useTabs.getState();
      const next = activateTab(setActivePane(s, loc.paneId), loc.paneId, slot.tabId);
      if (next !== s) useTabs.setState(next, true);
    }
    if (this.activeSlot !== slot) this.setActiveSlot(slot);
    else _setActiveEditor(slot.handle);
    setContext("editorTextFocus", true);
    setContext("editorFocus", true);
    this.publishContext();
  }

  onBlur(slot: EditorSlot) {
    setContext("editorTextFocus", false);
    if (this.autoSave()) void slot.model.save("auto").catch(() => {});
  }

  onSelection(slot: EditorSlot, navigatedFrom?: { line: number; col: number }) {
    if (slot !== this.activeSlot) return;
    if (navigatedFrom && this.navSuppress === 0 && !slot.disposed) {
      // The place left behind is where the caret was right before the navigation.
      this.nav.update({ path: slot.model.path, ...navigatedFrom });
      this.recordNav(slot, true);
    }
    // The status bar reflects the view state synchronously (programmatic and
    // synthetic selection changes included); events / history are throttled.
    this.publishStatus(slot);
    this.scheduleStatus();
    this.scheduleSessionSave();
  }

  onUserEdit(slot: EditorSlot) {
    if (!slot.model.virtual) {
      const c = slot.caret();
      this.edits.record({ path: slot.model.path, line: c.line, col: c.col });
    }
    const loc = this.locateTab(slot.tabId);
    if (loc?.tab.preview) useTabs.setState((s) => promoteTab(s, loc.paneId, slot.tabId), true);
  }

  onEscape(slot: EditorSlot): boolean {
    const loc = this.locateTab(slot.tabId);
    if (loc && useFindBars.getState()[loc.paneId]) {
      useFindBars.setState({ [loc.paneId]: undefined });
      return true;
    }
    return false;
  }

  onContextMenu(slot: EditorSlot, e: MouseEvent) {
    e.preventDefault();
    const view = slot.view;
    if (!view) return;
    // Right-click outside the selection moves the caret, like IDEA.
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos !== null && !view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to))
      view.dispatch({ selection: EditorSelection.cursor(pos) });
    const hasSel = !view.state.selection.main.empty;
    const items: MenuItem[] = [
      { kind: "action", action: "code.showIntentions", label: "Show Context Actions", icon: "bulb" },
      { kind: "separator" },
      // Like IDEA, Cut / Copy only with a selection.
      ...((hasSel
        ? [
            {
              label: "Cut",
              icon: "cut",
              shortcut: "⌘X",
              disabled: view.state.readOnly,
              run: () => {
                view.focus();
                document.execCommand("cut");
              },
            },
            {
              label: "Copy",
              icon: "copy",
              shortcut: "⌘C",
              run: () => {
                view.focus();
                document.execCommand("copy");
              },
            },
          ]
        : []) as MenuItem[]),
      {
        label: "Paste",
        icon: "paste",
        shortcut: "⌘V",
        disabled: view.state.readOnly,
        run: () => {
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
              view.focus();
            })
            .catch(() => {
              view.focus();
              document.execCommand("paste");
            });
        },
      },
      { kind: "separator" },
      {
        label: "Copy / Paste Special",
        submenu: [
          { label: "Copy Path", run: () => void navigator.clipboard?.writeText(slot.model.path) },
          { kind: "action", action: "code.pasteFromHistory" },
        ],
      },
      { kind: "action", action: "editor.toggleColumnSelection", label: "Column Selection Mode" },
      { kind: "separator" },
      // IDEA's editor popup: secondary commands live in submenus.
      {
        label: "Go To",
        submenu: [
          { kind: "action", action: "navigate.declaration", label: "Declaration or Usages" },
          { kind: "action", action: "navigate.implementation", label: "Implementation(s)" },
          { kind: "action", action: "navigate.typeDeclaration", label: "Type Declaration" },
          { kind: "action", action: "navigate.superMethod", label: "Super Method" },
          { kind: "action", action: "navigate.gotoTest", label: "Test" },
          { kind: "separator" },
          { kind: "action", action: "find.usages", label: "Find Usages" },
          { kind: "action", action: "navigate.callHierarchy", label: "Call Hierarchy" },
          { kind: "action", action: "navigate.typeHierarchy", label: "Type Hierarchy" },
        ],
      },
      { kind: "separator" },
      {
        label: "Folding",
        submenu: [
          { kind: "action", action: "code.unfold", label: "Expand" },
          { kind: "action", action: "code.fold", label: "Collapse" },
          { kind: "action", action: "code.unfoldAll", label: "Expand All" },
          { kind: "action", action: "code.foldAll", label: "Collapse All" },
          { kind: "separator" },
          { kind: "action", action: "code.foldSelection", label: "Fold Selection / Remove Region" },
        ],
      },
      { kind: "separator" },
      { kind: "action", action: "refactor.rename", label: "Rename…" },
      {
        label: "Refactor",
        submenu: [
          { kind: "action", action: "refactor.thisMenu", label: "Refactor This…" },
          { kind: "separator" },
          { kind: "action", action: "refactor.move" },
          { kind: "action", action: "refactor.changeSignature" },
          { kind: "action", action: "refactor.extractVariable" },
          { kind: "action", action: "refactor.extractConstant" },
          { kind: "action", action: "refactor.extractMethod" },
          { kind: "action", action: "refactor.inline" },
          { kind: "separator" },
          { kind: "action", action: "refactor.safeDelete" },
        ],
      },
      { kind: "action", action: "code.generate", label: "Generate…" },
      { kind: "separator" },
      // Contributed groups (Run / Debug '…', More Run/Debug).
      ...menuGroupItems("editor", {
        paths: [slot.model.path],
        text: view.state.doc.toString(),
        line: view.state.doc.lineAt(view.state.selection.main.head).number - 1,
      }),
      ...(slot.model.virtual
        ? ([
            { kind: "separator" },
            { label: "Copy Reference", run: () => void navigator.clipboard?.writeText(slot.model.path) },
          ] as MenuItem[])
        : ([
            { kind: "separator" },
            openInMenu(slot.model.path),
            { kind: "separator" },
            localHistoryMenu(slot.model.path),
            gitMenu(slot.model.path),
            { kind: "separator" },
            {
              kind: "action",
              action: "diff.compareWithClipboard",
              arg: { path: slot.model.path },
              label: "Compare with Clipboard",
            },
          ] as MenuItem[])),
    ];
    showContextMenu(e, items);
  }

  // --- status / context ------------------------------------------------------------

  private scheduleStatus() {
    if (this.statusScheduled) return;
    this.statusScheduled = true;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      this.statusScheduled = false;
      this.updateStatus();
    };
    // Animation frames pause while the window is hidden; the timeout keeps
    // the status and caret events from going stale then.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    setTimeout(run, typeof requestAnimationFrame === "function" ? 100 : 0);
  }

  private updateStatus() {
    const slot = this.activeSlot;
    if (!slot || slot.disposed) {
      useEditorStatus.setState({ status: null });
      this.publishContext();
      return;
    }
    const status = this.publishStatus(slot);
    _emitEditorEvent({
      type: "caretMoved",
      doc: status.doc,
      path: status.path,
      line: status.line,
      col: status.col,
      offset: status.offset,
    });
    this.recordNav(slot);
    this.publishContext();
  }

  /** Computes the status of `slot` from its current (view) state and stores it if changed. */
  private publishStatus(slot: EditorSlot): EditorStatus {
    const status = computeStatus(slot);
    const prev = useEditorStatus.getState().status;
    if (!prev || !sameStatus(prev, status)) useEditorStatus.setState({ status });
    return status;
  }

  publishContext() {
    const slot = this.activeSlot;
    const meta = slot?.model.getMeta();
    const s = useTabs.getState();
    setContext("editorPath", slot?.model.path ?? null);
    setContext("editorLangId", meta?.language ?? null);
    setContext("editorReadOnly", !!meta?.readOnly);
    setContext("editorHasSelection", !!slot && slot.currentState().selection.ranges.some((r) => !r.empty));
    setContext(
      "editorTabsOpen",
      Object.values(s.panes).some((p) => p.tabs.length > 0),
    );
    setContext("editorSplit", paneIds(s).length > 1);
    setContext("editorTextFocus", !!slot?.view?.hasFocus);
    setContext("textEditorActive", !!slot);
  }

  // --- navigation history --------------------------------------------------------------

  /** `navigation`: the caret got here by a navigation (see NavigationHistory.update). */
  private recordNav(slot: EditorSlot, navigation = false) {
    if (this.navSuppress > 0 || slot.disposed) return;
    const c = slot.caret();
    this.nav.update({ path: slot.model.path, line: c.line, col: c.col }, navigation);
  }

  async navigateTo(loc: NavigationLocation | null) {
    if (!loc) return;
    this.navSuppress++;
    try {
      await this.openFile(loc.path, { selection: { line: loc.line, col: loc.col }, focus: true });
    } finally {
      this.navSuppress--;
      if (this.activeSlot) this.recordNav(this.activeSlot);
    }
  }

  back() {
    if (this.activeSlot) this.recordNav(this.activeSlot);
    return this.navigateTo(this.nav.back());
  }

  forward() {
    return this.navigateTo(this.nav.forward());
  }

  /** Navigate › Last Edit Location (⇧⌘⌫): repeated, walks back through older edits. */
  lastEditLocation() {
    const slot = this.activeSlot;
    const caret = slot && !slot.disposed ? { path: slot.model.path, ...slot.caret() } : null;
    return this.goToEdit(this.edits.back(caret));
  }

  /** Navigate › Next Edit Location: back towards the newest edit. */
  nextEditLocation() {
    return this.goToEdit(this.edits.forward());
  }

  private async goToEdit(loc: { path: string; line: number; col: number } | null) {
    if (!loc) return false;
    if (this.activeSlot) this.recordNav(this.activeSlot);
    await this.openFile(loc.path, { selection: { line: loc.line, col: loc.col }, focus: true });
    return true;
  }

  // --- opening ---------------------------------------------------------------------------

  private openingGeneration() {
    const generation = { project: this.projectGeneration, admission: this.admissionGeneration };
    this.checkOpening(generation);
    return generation;
  }

  private checkOpening(generation: { project: number; admission: number }) {
    if (generation.project !== this.projectGeneration) throw new Error("The project changed while opening the editor");
    if (generation.admission !== this.admissionGeneration || this.closeSession || this.closeRequests)
      throw new Error("The project is closing");
  }

  async openFile(path: string, o: OpenOptions = {}) {
    const generation = this.openingGeneration();
    if (isVirtualUri(path)) return this.openVirtual(path, o);
    await this.projectTransition;
    this.checkOpening(generation);
    // Images, binary and huge files open in a contributed viewer unless already open as text.
    if (!o.asText && !findTab(useTabs.getState(), fileKey(path))) {
      const viewer = await resolveFileEditor(path);
      if (viewer) {
        try {
          await this.admitInput(viewer.input, o, generation, viewer);
        } finally {
          await viewer.rollback();
        }
        return;
      }
    }
    await this.admitInput(fileInput(path), o, generation);
  }

  /** Opens the library class (or other server-provided document) behind `uri` read-only. */
  async openVirtual(uri: string, o: OpenOptions = {}) {
    const generation = this.openingGeneration();
    await this.projectTransition;
    this.checkOpening(generation);
    let vd: VirtualDocument;
    try {
      vd = await virtualDocument(uri);
    } catch (e) {
      notifications().notify({
        level: "warning",
        title: "Cannot open library class",
        body: e instanceof Error ? e.message : String(e),
        group: "lsp",
      });
      return;
    }
    await this.admitInput(virtualInput(vd), o, generation);
  }

  async openInput(input: EditorInput, o: OpenOptions = {}) {
    return this.admitInput(input, o, this.openingGeneration());
  }

  private async admitInput(
    input: EditorInput,
    o: OpenOptions,
    generation: { project: number; admission: number },
    resolution?: FileEditorResolution,
  ) {
    await this.projectTransition;
    this.checkOpening(generation);
    await this.closingDocuments.get(input.key);
    this.checkOpening(generation);
    this.navSuppress++;
    try {
      let s = useTabs.getState();
      let paneId = o.pane && s.panes[o.pane] ? o.pane : s.activePane;
      if (o.side) {
        const right = neighbourPane(s, paneId);
        if (right) paneId = right;
        else {
          const split = splitPane(s, paneId, "row");
          s = split.state;
          paneId = split.paneId;
          // The new pane starts with only the requested input.
          const pane = s.panes[paneId]!;
          s = { ...s, panes: { ...s.panes, [paneId]: { ...pane, tabs: [], active: null, mru: [] } } };
        }
      }
      const found = findTab(s, input.key, paneId);
      let tabId: string;
      if (found && (!(o.side || o.pane) || found.paneId === paneId)) {
        paneId = found.paneId;
        s = activateTab(setActivePane(s, paneId), paneId, found.tab.id);
        if (!o.preview || documentLifecycle(input, useContributions.getState().editorKinds))
          s = promoteTab(s, paneId, found.tab.id);
        tabId = found.tab.id;
        if (found.tab.input.data !== input.data && input.data !== undefined)
          s = openTab(s, paneId, input, {
            preview: o.preview && !documentLifecycle(input, useContributions.getState().editorKinds),
          }).state;
      } else {
        const tabs = editorPrefs().tabs;
        const preview =
          !!o.preview && tabs.previewTab && !documentLifecycle(input, useContributions.getState().editorKinds);
        const r = openTab(s, paneId, input, {
          preview,
          ...(tabs.openAtEnd ? { index: s.panes[paneId]?.tabs.length ?? 0 } : {}),
        });
        s = r.state;
        tabId = r.tabId;
        if (tabs.sortAlphabetically) s = sortTabs(s, paneId, (t) => tabSortKey(t.input));
      }
      resolution?.admit();
      useTabs.setState(s, true);
      const tabPrefs = editorPrefs().tabs;
      await this.removeGuarded(
        (current) =>
          current.panes[paneId]
            ? enforceTabLimit(
                current,
                paneId,
                tabPrefs.tabLimit,
                tabPrefs.closingPolicy,
                (tab) =>
                  inputDirty(tab.input, useContributions.getState().editorKinds) ??
                  !!(tab.input.path && useDocMeta.getState()[tab.input.path]?.dirty),
                tabId,
                (tab) => inputDirty(tab.input, useContributions.getState().editorKinds) === true,
              )
            : current,
        { protect: (tab) => inputDirty(tab.input, useContributions.getState().editorKinds) === true },
      );
      if (!isTextInput(input)) {
        if (o.focus !== false) requestAnimationFrame(() => this.focus());
        return;
      }
      const slot = await this.ensureSlot(tabId);
      if (!slot) return;
      if (o.selection) {
        const state = slot.currentState();
        const toOffset = (line: number, col: number) => {
          const l = state.doc.line(Math.min(Math.max(1, line + 1), state.doc.lines));
          return l.from + Math.min(Math.max(0, col), l.length);
        };
        const anchor = toOffset(o.selection.line, o.selection.col);
        const head =
          o.selection.endLine !== undefined ? toOffset(o.selection.endLine, o.selection.endCol ?? 0) : anchor;
        // Selection runs anchor→head; place the caret at the start like IDEA's navigation.
        slot.reveal({ anchor: head, head: anchor, center: true });
      }
      if (o.focus !== false) {
        if (slot.view) slot.focus();
        else slot.wantsFocus = true;
      }
    } finally {
      this.navSuppress--;
      if (this.navSuppress === 0 && this.activeSlot) this.recordNav(this.activeSlot, true);
    }
  }

  activate(paneId: string, tabId: string, focus = true) {
    useTabs.setState((s) => activateTab(setActivePane(s, paneId), paneId, tabId), true);
    if (focus) {
      const slot = this.slots.get(tabId);
      if (slot?.view) slot.focus();
      else if (slot) slot.wantsFocus = true;
      else void this.ensureSlot(tabId).then((sl) => sl && (sl.view ? sl.focus() : (sl.wantsFocus = true)));
    }
  }

  /** Window › Editor Tabs › Goto Next / Previous Splitter: the active tab of the next split pane, wrapping. */
  focusSplitter(dir: 1 | -1) {
    const s = useTabs.getState();
    const ids = paneIds(s).filter((id) => s.panes[id]?.active);
    if (ids.length < 2) return;
    const next = ids[(ids.indexOf(s.activePane) + dir + ids.length) % ids.length]!;
    this.activate(next, s.panes[next]!.active!);
  }

  // --- tab commands -----------------------------------------------------------------------------

  private apply(f: (s: TabsState) => TabsState) {
    useTabs.setState((s) => f(s), true);
  }

  private documentError(error: unknown) {
    notifications().notify({
      level: "error",
      title: t("app.unsaved.saveFailed"),
      body: error instanceof Error ? error.message : String(error),
    });
  }

  private enqueueRemoval<T>(run: () => Promise<T>): Promise<T> {
    const result = this.removalTail.then(run);
    this.removalTail = result.catch(() => {});
    return result;
  }

  private releaseDocuments(documents: Iterable<CustomDocument>): Promise<void> {
    const pending = [...documents].map((d) => {
      const key = d.input.key;
      const previous = this.closingDocuments.get(key) ?? Promise.resolve();
      const close = previous.then(() => d.lifecycle.close(d.input));
      this.closingDocuments.set(key, close);
      return close.finally(() => {
        if (this.closingDocuments.get(key) === close) this.closingDocuments.delete(key);
      });
    });
    return Promise.allSettled(pending).then((results) => {
      const errors = failures(results);
      if (errors.length) throw combinedError(errors);
    });
  }

  /** Close exactly the originally selected tabs, evaluating references after every await. */
  private removeGuarded(
    select: (s: TabsState) => TabsState,
    options: { protect?: (tab: Tab) => boolean; clearHistory?: boolean } = {},
  ): Promise<boolean> {
    const generation = this.projectGeneration;
    const initial = useTabs.getState();
    const planned = select(initial);
    const remainingIds = new Set(Object.values(planned.panes).flatMap((p) => p.tabs.map((t) => t.id)));
    const targets = new Set(
      Object.values(initial.panes).flatMap((p) => p.tabs.filter((t) => !remainingIds.has(t.id)).map((t) => t.id)),
    );
    const emptyPanes = paneIds(initial).filter((id) => !planned.panes[id] && !initial.panes[id]?.tabs.length);
    return this.enqueueRemoval(async () => {
      if (generation !== this.projectGeneration || this.closeSession) return false;
      const prepared: CustomDocument[] = [];
      const currentRemoval = (s: TabsState) => {
        let next = s;
        for (const [paneId, pane] of Object.entries(s.panes))
          for (const tab of pane.tabs)
            if (targets.has(tab.id) && next.panes[paneId] && !options.protect?.(tab))
              next = closeTab(next, paneId, tab.id);
        for (const id of emptyPanes)
          if (next.panes[id]?.tabs.length === 0 && paneIds(next).length > 1) next = removePane(next, id);
        return next;
      };
      const stillLast = (d: CustomDocument) => {
        if (generation !== this.projectGeneration) return false;
        const current = useTabs.getState();
        return openKeys(current).has(d.input.key) && !openKeys(currentRemoval(current)).has(d.input.key);
      };
      try {
        const authorized = new Set<string>();
        const discards = new Map<string, CustomDocument>();
        for (;;) {
          const current = useTabs.getState();
          const d = closedDocuments(current, currentRemoval(current), useContributions.getState().editorKinds).find(
            (document) => !authorized.has(document.input.key),
          );
          if (!d) {
            // A later Cancel/save failure must not discard earlier documents.
            const discard = [...discards.values()].find(stillLast);
            if (!discard) break;
            discards.delete(discard.input.key);
            await discard.lifecycle.discard(discard.input);
            // The await may have changed which documents lose their last tab.
            if (generation !== this.projectGeneration) return false;
            continue;
          }
          if (!prepared.some((document) => document.input.key === d.input.key)) {
            prepared.push(d);
            this.preparedDocuments.set(d.input.key, d);
            await d.lifecycle.prepareClose(d.input);
          }
          if (generation !== this.projectGeneration) return false;
          if (!stillLast(d)) continue;
          if (documentDirty(d)) {
            const decision = await ask({
              title: t("app.unsaved.title"),
              body: t("app.unsaved.body", { count: 1, project: d.input.path ?? d.input.key }),
              buttons: [
                { id: "discard", label: t("app.unsaved.discard") },
                { id: "save", label: t("app.unsaved.save"), primary: true },
              ],
              icon: "warning",
            });
            if (!stillLast(d)) continue;
            if (decision.button === "save") await d.lifecycle.save(d.input);
            else if (decision.button === "discard") discards.set(d.input.key, d);
            else return false;
          }
          authorized.add(d.input.key);
        }
        // Commit only the original target ids against the latest tab state.
        if (generation !== this.projectGeneration) return false;
        const before = useTabs.getState();
        const next = currentRemoval(before);
        const closed = closedDocuments(before, next, useContributions.getState().editorKinds);
        const closedKeys = new Set(closed.map((d) => d.input.key));
        for (const d of prepared) if (!closedKeys.has(d.input.key)) d.lifecycle.cancelClose(d.input);
        // Remove frozen markers only after the tab reaction, to prevent autosave.
        useTabs.setState(options.clearHistory ? { ...next, closed: [] } : next, true);
        for (const d of prepared) this.preparedDocuments.delete(d.input.key);
        prepared.length = 0;
        await this.releaseDocuments(closed);
        return true;
      } catch (e) {
        this.documentError(e);
        return false;
      } finally {
        for (const d of prepared) {
          if (this.preparedDocuments.get(d.input.key) === d) this.preparedDocuments.delete(d.input.key);
          if (generation === this.projectGeneration) d.lifecycle.cancelClose(d.input);
        }
      }
    });
  }

  closeTab(paneId: string, tabId: string): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? closeTab(s, paneId, tabId) : s));
  }
  closeOthers(paneId: string, tabId: string): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? closeOthers(s, paneId, tabId) : s), {
      protect: (tab) => tab.pinned,
    });
  }
  closeAll(paneId: string, keepPinned = false): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? closeAll(s, paneId, keepPinned) : s), {
      protect: (tab) => keepPinned && tab.pinned,
    });
  }
  closeToRight(paneId: string, tabId: string): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? closeToRight(s, paneId, tabId) : s), {
      protect: (tab) => tab.pinned,
    });
  }
  closeToLeft(paneId: string, tabId: string): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? closeToLeft(s, paneId, tabId) : s), {
      protect: (tab) => tab.pinned,
    });
  }
  /** Keeps tabs with unsaved changes or a VCS status (IDEA: tabs shown as modified). */
  closeUnmodified(paneId: string): Promise<boolean> {
    const modified = (tab: Tab) =>
      (inputDirty(tab.input, useContributions.getState().editorKinds) ?? false) ||
      !!(tab.input.path && (useDocMeta.getState()[tab.input.path]?.dirty || getFileDecoration(tab.input.path)?.color));
    return this.removeGuarded((s) => (s.panes[paneId] ? closeUnmodified(s, paneId, modified) : s), {
      protect: (tab) => tab.pinned || modified(tab),
    });
  }
  closeReadOnly(paneId: string): Promise<boolean> {
    const writable = (t: Tab) => !t.input.path || !useDocMeta.getState()[t.input.path]?.readOnly;
    return this.removeGuarded((s) => (s.panes[paneId] ? closeUnmodified(s, paneId, writable) : s), {
      protect: (tab) => tab.pinned || writable(tab),
    });
  }
  /** Reload from Disk: re-reads the open, unmodified documents of `paths`. */
  async reloadFromDisk(paths: string[]) {
    for (const path of paths) {
      const model = this.manager.get(path);
      if (!model) continue;
      const meta = model.getMeta();
      if (meta.dirty) {
        notifications().notify({
          level: "warning",
          title: `${path.slice(path.lastIndexOf("/") + 1)} has unsaved changes`,
          body: "Save or roll back the changes before reloading it from disk.",
        });
        continue;
      }
      try {
        const encoding = await this.manager.backend.setEncoding(meta.doc, meta.encoding, true);
        model.setMeta({ encoding });
      } catch (e) {
        notifications().notify({
          level: "error",
          title: "Cannot reload from disk",
          body: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  togglePin(paneId: string, tabId: string) {
    this.apply((s) => togglePin(s, paneId, tabId));
  }
  /** Turns a preview tab into a regular one (double-click on the tab). */
  keepTab(paneId: string, tabId: string) {
    this.apply((s) => (s.panes[paneId] ? promoteTab(s, paneId, tabId) : s));
  }
  /** Drag & drop; the tab keeps its id (and slot) when moved within a pane. */
  moveTab(fromPane: string, tabId: string, toPane: string, index: number) {
    this.apply((s) => moveTab(s, fromPane, tabId, toPane, index));
  }
  /** Drag & drop onto an editor edge: the tab moves into a new split on that side. */
  moveTabToSplit(fromPane: string, tabId: string, targetPane: string, edge: SplitEdge) {
    const r = moveTabToNewSplit(useTabs.getState(), fromPane, tabId, targetPane, edge);
    if (!r) return;
    useTabs.setState(r.state, true);
    const slot = this.slots.get(tabId);
    if (slot?.view) slot.focus();
    else if (slot) slot.wantsFocus = true;
  }
  /** Files dropped on an editor: opened in that pane, or in a new split at `edge`. */
  async openFilesIn(paths: readonly string[], paneId: string, edge: SplitEdge | "center") {
    const s = useTabs.getState();
    if (!s.panes[paneId] || !paths.length) return;
    let target = paneId;
    if (edge !== "center") {
      const r = splitAtEdge(s, paneId, edge);
      useTabs.setState(r.state, true);
      target = r.paneId;
    }
    for (const [i, path] of paths.entries()) await this.openFile(path, { pane: target, focus: i === paths.length - 1 });
    const pane = useTabs.getState().panes[target];
    if (pane && !pane.tabs.length) this.apply((st) => removePane(st, target));
  }
  /** IDEA "Move to Opposite Group"; without a split, "Split and Move Right". */
  moveToOpposite(paneId: string, tabId: string) {
    const target = neighbourPane(useTabs.getState(), paneId);
    if (!target) return this.moveTabToSplit(paneId, tabId, paneId, "right");
    this.apply((s) => moveTab(s, paneId, tabId, target, paneOf(s, target).tabs.length));
    this.focus();
  }
  cycle(delta: number) {
    this.apply((s) => cycleTab(s, delta));
    this.focus();
  }
  async reopenClosed(): Promise<void> {
    const generation = this.projectGeneration;
    await this.projectTransition;
    await this.removalTail;
    if (generation !== this.projectGeneration || this.closeSession) return;
    const r = reopenClosed(useTabs.getState());
    if (!r) return;
    useTabs.setState(r.state, true);
    void this.ensureSlot(r.tabId).then((slot) => slot && (slot.view ? slot.focus() : (slot.wantsFocus = true)));
  }

  split(paneId: string, dir: "row" | "column") {
    const s = useTabs.getState();
    const srcPane = s.panes[paneId];
    const srcSlot = srcPane?.active ? this.slots.get(srcPane.active) : undefined;
    const r = splitPane(s, paneId, dir);
    useTabs.setState(r.state, true);
    const newTab = r.state.panes[r.paneId]?.active;
    if (newTab) {
      void this.ensureSlot(newTab, { from: srcSlot }).then((slot) => {
        if (slot?.view) slot.focus();
        else if (slot) slot.wantsFocus = true;
      });
    }
  }

  unsplit(paneId: string): Promise<boolean> {
    return this.removeGuarded((s) => (s.panes[paneId] ? removePane(s, paneId) : s));
  }
  async unsplitAll(paneId: string): Promise<boolean> {
    const closed = await this.removeGuarded((s) => unsplitAll(s, paneId));
    if (closed) {
      this.apply((s) => setActivePane(s, paneId));
      this.focus();
    }
    return closed;
  }
  changeSplitOrientation(paneId: string) {
    this.apply((s) => changeSplitOrientation(s, paneId));
  }
  /** IDEA "Open in Opposite Group": the tab stays and a copy opens next door (or in a new split). */
  openInOpposite(paneId: string, tabId: string) {
    const s = useTabs.getState();
    const tab = s.panes[paneId]?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const target = neighbourPane(s, paneId);
    if (!target) {
      this.activate(paneId, tabId, false);
      return this.split(paneId, "row");
    }
    const r = openTab(s, target, tab.input);
    useTabs.setState(r.state, true);
    void this.ensureSlot(r.tabId, { from: this.slots.get(tabId) }).then((slot) => {
      if (slot?.view) slot.focus();
      else if (slot) slot.wantsFocus = true;
    });
  }

  closeActiveTab(): Promise<boolean> {
    const s = useTabs.getState();
    const pane = s.panes[s.activePane];
    if (pane?.active) return this.closeTab(pane.id, pane.active);
    if (paneIds(s).length > 1) return this.unsplit(s.activePane);
    return Promise.resolve(true);
  }

  closeEverything(): Promise<boolean> {
    return this.removeGuarded(
      (s) => {
        let next = s;
        for (const id of paneIds(s)) if (next.panes[id]) next = closeAll(next, id);
        return next;
      },
      { clearHistory: true },
    );
  }

  private onFilesRemoved(removed: string[]) {
    if (!removed.length) return;
    const kinds = useContributions.getState().editorKinds;
    const inputs = new Map<string, EditorInput>();
    for (const pane of Object.values(useTabs.getState().panes))
      for (const tab of pane.tabs) {
        const path = tab.input.path;
        if (path && removed.some((root) => path === root || path.startsWith(`${root}/`)))
          inputs.set(tab.input.key, tab.input);
      }
    for (const input of inputs.values()) {
      if (inputDirty(input, kinds) === true || (input.path && this.manager.get(input.path)?.getMeta().dirty)) continue;
      // A pending output/edit can make the document dirty before this queued
      // removal runs. Recheck then; external deletion never discards edits.
      void this.removeGuarded((s) => closeKey(s, input.key), {
        protect: (tab) =>
          inputDirty(tab.input, kinds) === true || !!(tab.input.path && useDocMeta.getState()[tab.input.path]?.dirty),
      });
      if (input.path) {
        this.nav.removePath(input.path);
        this.edits.removePath(input.path);
      }
    }
  }

  // --- service helpers ------------------------------------------------------------------

  focus() {
    const tab = this.activeTabOf();
    if (!tab) {
      document.querySelector<HTMLElement>("[data-editor-area]")?.focus({ preventScroll: true });
      return;
    }
    const slot = this.slots.get(tab.id);
    if (slot?.view) {
      slot.focus();
      return;
    }
    if (slot) {
      slot.wantsFocus = true;
      return;
    }
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${useTabs.getState().activePane}"]`);
    pane?.querySelector<HTMLElement>("[data-editor-focus], .cm-content")?.focus({ preventScroll: true });
  }

  private stampActive(s: TabsState) {
    const pane = s.panes[s.activePane];
    const key = pane?.tabs.find((t) => t.id === pane.active)?.input.key;
    if (key && this.lastActive.get(key) !== this.activeClock) this.lastActive.set(key, ++this.activeClock);
  }

  /** Every open tab once (all panes), most recently active first; tabs never active this session follow in tab order. */
  openTabs(): OpenEditorTab[] {
    const s = useTabs.getState();
    const kinds = useContributions.getState().editorKinds;
    const out = new Map<string, OpenEditorTab>();
    for (const id of paneIds(s))
      for (const t of s.panes[id]?.tabs ?? [])
        if (!out.has(t.input.key))
          out.set(t.input.key, {
            input: t.input,
            title: tabTitle(t.input, kinds),
            icon: tabIcon(t.input, kinds),
            lastActive: this.lastActive.get(t.input.key) ?? 0,
          });
    return [...out.values()].sort((a, b) => b.lastActive - a.lastActive);
  }

  openPaths(): string[] {
    const s = useTabs.getState();
    const out = new Set<string>();
    for (const id of paneIds(s)) for (const t of s.panes[id]?.tabs ?? []) if (t.input.path) out.add(t.input.path);
    return [...out];
  }

  closePath(path: string): Promise<boolean> {
    return this.removeGuarded((s) => {
      const keys = new Set<string>();
      for (const pane of Object.values(s.panes))
        for (const t of pane.tabs) if (t.input.path === path) keys.add(t.input.key);
      let next = s;
      for (const key of keys) next = closeKey(next, key);
      return next;
    });
  }

  closeInput(key: string): Promise<boolean> {
    return this.removeGuarded((s) => closeKey(s, key));
  }

  activeInput(): EditorInput | null {
    return this.activeTabOf()?.input ?? null;
  }

  onActiveInputChange(fn: (input: EditorInput | null) => void): () => void {
    let prev = this.activeInput()?.key;
    return useTabs.subscribe(() => {
      const input = this.activeInput();
      if (input?.key === prev) return;
      prev = input?.key;
      fn(input);
    });
  }

  activePath(): string | null {
    return this.activeSlot?.model.path ?? this.activeTabOf()?.input.path ?? null;
  }

  activeCursor() {
    const slot = this.activeSlot;
    if (!slot) return null;
    return { doc: slot.model.doc, path: slot.model.path, ...slot.caret() };
  }

  private async saveCustomDocuments(auto = false): Promise<void> {
    const documents = customDocuments(useTabs.getState(), useContributions.getState().editorKinds);
    const results = await Promise.allSettled(
      [...documents.values()]
        .filter((d) => (!auto || !this.preparedDocuments.has(d.input.key)) && documentDirty(d))
        .map((d) => Promise.resolve().then(() => d.lifecycle.save(d.input))),
    );
    const errors = failures(results);
    if (errors.length) throw combinedError(errors);
  }

  async saveAll(): Promise<void> {
    const results = await Promise.allSettled([this.manager.saveAll("explicit"), this.saveCustomDocuments()]);
    const errors = failures(results);
    if (errors.length) throw combinedError(errors);
  }

  /** Hold every open custom document still until the project/window decision. */
  prepareClose(): Promise<EditorCloseSession> {
    ++this.admissionGeneration;
    ++this.closeRequests;
    return this.enqueueRemoval(async () => {
      if (this.closeSession) throw new Error("An editor close decision is already pending");
      const generation = this.projectGeneration;
      const documents = [...customDocuments(useTabs.getState(), useContributions.getState().editorKinds).values()];
      const prepared: CustomDocument[] = [];
      let settled = false;
      const session: EditorCloseSession = {
        dirty: 0,
        discard: async () => {
          if (settled || this.closeSession !== session || generation !== this.projectGeneration)
            throw new Error("The editor close decision is no longer current");
          const results = await Promise.allSettled(
            documents.filter(documentDirty).map((d) => Promise.resolve().then(() => d.lifecycle.discard(d.input))),
          );
          const errors = failures(results);
          if (errors.length) throw combinedError(errors);
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          if (this.closeSession !== session || generation !== this.projectGeneration) return;
          this.closeSession = null;
          this.closeCommitted = false;
          for (const d of prepared) {
            this.preparedDocuments.delete(d.input.key);
            d.lifecycle.cancelClose(d.input);
          }
        },
        commit: () => {
          if (settled || this.closeSession !== session || generation !== this.projectGeneration)
            throw new Error("The editor close decision is no longer current");
          this.closeCommitted = true;
        },
      };
      this.closeSession = session;
      try {
        for (const d of documents) {
          prepared.push(d);
          this.preparedDocuments.set(d.input.key, d);
          await d.lifecycle.prepareClose(d.input);
          if (generation !== this.projectGeneration) throw new Error("The project changed during close");
          if (this.closeSession !== session) {
            d.lifecycle.cancelClose(d.input);
            throw new Error("The editor close decision was cancelled");
          }
        }
        session.dirty = documents.filter(documentDirty).length;
        return session;
      } catch (e) {
        session.cancel();
        throw e;
      }
    }).finally(() => {
      --this.closeRequests;
    });
  }

  cancelClose(): void {
    this.closeSession?.cancel();
  }

  documentHistory(command: "undo" | "redo"): boolean {
    const input = this.activeTabOf()?.input;
    if (!input) return false;
    const lifecycle = documentLifecycle(input, useContributions.getState().editorKinds);
    const run = lifecycle?.[command];
    if (!run) return false;
    void run.call(lifecycle, input).catch((e) => this.documentError(e));
    return true;
  }

  /** Context menu of a tab (IDEA's EditorTabPopupMenu). */
  tabMenu(paneId: string, tab: Tab): MenuItem[] {
    const path = tab.input.kind === "virtual" ? undefined : tab.input.path;
    const tabs = useTabs.getState().panes[paneId]?.tabs ?? [];
    const index = tabs.findIndex((t) => t.id === tab.id);
    const split = paneIds(useTabs.getState()).length > 1;
    const project = useProject.getState().project;
    const inProject = !!path && !!project && (path === project.root || path.startsWith(`${project.root}/`));
    const activateThen = (run: () => void) => () => {
      this.activate(paneId, tab.id, false);
      run();
    };
    return [
      { label: "Close", shortcut: shortcutLabel("editor.closeTab"), run: () => void this.closeTab(paneId, tab.id) },
      { label: "Close Other Tabs", disabled: tabs.length < 2, run: () => void this.closeOthers(paneId, tab.id) },
      { label: "Close Tabs to the Left", disabled: index <= 0, run: () => void this.closeToLeft(paneId, tab.id) },
      {
        label: "Close Tabs to the Right",
        disabled: index < 0 || index >= tabs.length - 1,
        run: () => void this.closeToRight(paneId, tab.id),
      },
      { label: "Close All Tabs", run: () => void this.closeAll(paneId) },
      { label: "Close Unmodified Tabs", run: () => void this.closeUnmodified(paneId) },
      ...(tabs.some((t) => t.pinned)
        ? ([{ label: "Close All but Pinned", run: () => void this.closeAll(paneId, true) }] as MenuItem[])
        : []),
      ...(tabs.some((t) => !t.pinned && !!t.input.path && useDocMeta.getState()[t.input.path]?.readOnly)
        ? ([{ label: "Close All Read-Only Tabs", run: () => void this.closeReadOnly(paneId) }] as MenuItem[])
        : []),
      { kind: "separator" },
      { label: tab.pinned ? "Unpin Tab" : "Pin Tab", icon: "pin", run: () => this.togglePin(paneId, tab.id) },
      ...(tab.preview ? ([{ label: "Keep Tab Open", run: () => this.keepTab(paneId, tab.id) }] as MenuItem[]) : []),
      { kind: "separator" },
      { label: "Split and Move Right", run: () => this.moveTabToSplit(paneId, tab.id, paneId, "right") },
      { label: "Split and Move Down", run: () => this.moveTabToSplit(paneId, tab.id, paneId, "bottom") },
      {
        label: "Split Right",
        icon: "split",
        shortcut: shortcutLabel("editor.splitRight"),
        run: activateThen(() => this.split(paneId, "row")),
      },
      {
        label: "Split Down",
        icon: "split-horizontal",
        shortcut: shortcutLabel("editor.splitDown"),
        run: activateThen(() => this.split(paneId, "column")),
      },
      ...(split
        ? ([
            { label: "Move to Opposite Group", run: () => this.moveToOpposite(paneId, tab.id) },
            { label: "Open in Opposite Group", run: () => this.openInOpposite(paneId, tab.id) },
            { label: "Change Splitter Orientation", run: () => this.changeSplitOrientation(paneId) },
            { label: "Unsplit", run: () => void this.unsplit(paneId) },
            { label: "Unsplit All", run: () => void this.unsplitAll(paneId) },
          ] as MenuItem[])
        : []),
      { kind: "separator" },
      ...(path
        ? ([
            // Contributed groups (Run / Debug '…', More Run/Debug ›), each followed by a separator.
            ...menuGroupItems("editorTab", { paths: [path], text: this.slots.get(tab.id)?.view?.state.doc.toString() }),
            openInMenu(path),
            { kind: "separator" },
            localHistoryMenu(path),
            ...(inProject ? [gitMenu(path)] : []),
            { kind: "separator" },
            {
              label: "Copy Path/Reference…",
              submenu: [
                { kind: "action", action: "project.copyAbsolutePath", arg: path, label: "Absolute Path" },
                { kind: "action", action: "project.copyFileName", arg: path, label: "File Name" },
                ...(inProject
                  ? ([
                      {
                        kind: "action",
                        action: "project.copyRelativePath",
                        arg: path,
                        label: "Path From Content Root",
                      },
                    ] as MenuItem[])
                  : []),
              ],
            },
            { kind: "action", action: "project.rename", arg: path, label: "Rename File…" },
            { kind: "separator" },
          ] as MenuItem[])
        : []),
      { kind: "action", action: "file.settings", arg: "editor.general.editorTabs", label: "Configure Editor Tabs…" },
    ];
  }
}

/** Open In › for a file: Project View, Finder / Explorer / Files, Terminal. */
function openInMenu(path: string): MenuItem {
  return {
    label: "Open In",
    submenu: [
      { kind: "action", action: "navigate.selectIn", arg: { path }, label: "Project View" },
      { kind: "action", action: "project.revealInFinder", arg: path, label: revealLabel() },
      { kind: "action", action: "project.openInTerminal", arg: path, label: "Terminal" },
      { kind: "separator" },
      ...menuGroupItems("openIn", { paths: [path] }),
    ],
  };
}

function localHistoryMenu(path: string): MenuItem {
  return {
    label: "Local History",
    submenu: [
      { kind: "action", action: "vcs.localHistory", arg: { path }, label: "Show History" },
      { kind: "action", action: "localHistory.putLabel", label: "Put Label…" },
    ],
  };
}

/** Git › for one file (editor and editor tab menus). */
function gitMenu(path: string): MenuItem {
  return {
    label: "Git",
    submenu: [
      { kind: "action", action: "vcs.commit", label: "Commit File…" },
      { kind: "action", action: "vcs.addToVcs", arg: [path], label: "Add" },
      { kind: "separator" },
      { kind: "action", action: "vcs.annotate", arg: path, label: "Annotate with Git Blame" },
      { kind: "action", action: "vcs.showDiff", arg: [path], label: "Show Diff" },
      { kind: "action", action: "vcs.compareWithBranch", arg: { path }, label: "Compare with Branch…" },
      { kind: "action", action: "vcs.showHistory", arg: [path], label: "Show History" },
      { kind: "action", action: "vcs.rollback", arg: [path], label: "Rollback…" },
      { kind: "separator" },
      { kind: "action", action: "vcs.push", label: "Push…" },
      { kind: "action", action: "vcs.update", label: "Pull…" },
      { kind: "action", action: "vcs.fetch", label: "Fetch" },
      { kind: "separator" },
      { kind: "action", action: "vcs.branches", label: "Branches…" },
    ],
  };
}

function sameStatus(a: EditorStatus, b: EditorStatus): boolean {
  return (
    a.path === b.path &&
    a.doc === b.doc &&
    a.offset === b.offset &&
    a.line === b.line &&
    a.col === b.col &&
    a.selectedChars === b.selectedChars &&
    a.selectedLines === b.selectedLines &&
    a.carets === b.carets
  );
}

/** Status bar caret / selection info derived from the slot's latest state. */
export function computeStatus(slot: EditorSlot): EditorStatus {
  const state = slot.currentState();
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  let chars = 0;
  let lines = 0;
  for (const r of state.selection.ranges) {
    chars += r.to - r.from;
    if (!r.empty) lines += state.doc.lineAt(r.to).number - state.doc.lineAt(r.from).number;
  }
  const status: EditorStatus = {
    path: slot.model.path,
    doc: slot.model.doc,
    line: line.number - 1,
    col: main.head - line.from,
    offset: main.head,
    selectedChars: chars,
    selectedLines: lines,
    carets: state.selection.ranges.length,
  };
  return status;
}

let controller: EditorController | null = null;

export function editorController(): EditorController {
  return (controller ??= new EditorController());
}

/** "Finder" / "Explorer" / "Files", like IDEA's Open In submenu. */
function revealLabel(): string {
  const os = usePlatform.getState().os;
  return os === "macos" ? "Finder" : os === "windows" ? "Explorer" : "Files";
}
