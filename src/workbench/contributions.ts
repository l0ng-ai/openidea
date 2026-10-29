/**
 * Workbench extension points. Features contribute UI here instead of the
 * workbench importing features, so feature folders stay independent:
 *
 *   registerToolWindow({ id: "project", title: "Project", icon: "folder",
 *                        anchor: "left", component: ProjectView });
 *
 * The workbench renders whatever is registered; the action
 * `toolwindow.<id>` toggles it (registered automatically).
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import type { RunConfig } from "@/bindings";
import type { MenuItem } from "@/ui/Menu";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type ToolWindowAnchor = "left" | "right" | "bottom";

export interface ToolWindowContribution {
  id: string;
  title: string;
  /** Icon name from `ui/icons`. */
  icon: string;
  anchor: ToolWindowAnchor;
  /** Order within its stripe group; lower first. */
  order?: number;
  /**
   * Docks in the side's split area (IDEA `secondary` / `isSplit`): Left Bottom,
   * Bottom Right or Right Bottom, so it can show beside the primary window.
   */
  secondary?: boolean;
  component: ComponentType<{ id: string }>;
  /** Extra header controls, right-aligned (shown on hover like IDEA). */
  headerActions?: ComponentType<{ id: string }>;
  /**
   * Content tabs rendered right after the title (Terminal "Local × + ▾",
   * Run sessions…). The header then gets a bottom divider.
   */
  headerContent?: ComponentType<{ id: string }>;
  /** The content tabs name the window themselves (IDEA's Commit | Shelf | Stash): no title. */
  tabsReplaceTitle?: boolean;
  /**
   * Window-specific entries of the header's "⋮" options menu, shown above the
   * generic ones (Move to, Maximize, Hide). Either static items or a React
   * hook returning items (may read stores, e.g. for checked state). When
   * present the header title also gets a "▾" opening just these items.
   */
  headerMenu?: MenuItem[] | ((id: string) => MenuItem[]);
  /**
   * The title as a view switcher (IDEA's "Project ▾" panes): a React hook
   * returning the current view's label and the items the title opens instead
   * of `headerMenu`'s.
   */
  titleMenu?: (id: string) => { label: string; items: MenuItem[] };
  /** Badge (e.g. problem count) shown on the stripe button. */
  useBadge?: () => number | string | null;
  /** Only shown when a project is open (default true). */
  requiresProject?: boolean;
  /**
   * Whether the stripe has a button before the user decides (IDEA): "shown",
   * or "onUse" — listed under the stripe's "…" until first opened (Find, Run…).
   */
  stripe?: "shown" | "onUse";
}

export type StatusAlign = "left" | "right";

export interface StatusItemContribution {
  id: string;
  align: StatusAlign;
  /** Higher = further from the centre (closer to the window edge). */
  priority: number;
  component: ComponentType;
  /**
   * Name in the status bar context menu, where the user can hide or show the
   * widget (IDEA's "Status Bar Widgets"). Untitled items are always shown.
   */
  title?: string;
  /** Shown until the user decides otherwise (default true). */
  defaultVisible?: boolean;
  /** Also shown in a LightEdit window (editor tabs only), whose status bar has only such items. */
  lightEdit?: boolean;
}

/** Title bar widget (VCS branch, run configuration, run/debug buttons…). */
export interface TitleItemContribution {
  id: string;
  align: "left" | "right";
  /** Higher = further from the centre (closer to the window edge). */
  priority: number;
  component: ComponentType;
  /** Name in Customize Main Toolbar (defaults to the id). */
  title?: string;
}

/** Popups / dialogs rendered above the workbench (Search Everywhere, Settings…). */
export interface OverlayContribution {
  id: string;
  component: ComponentType;
}

/** Editor tab types other than text files: diff viewer, settings, welcome… */
export interface EditorKindContribution {
  kind: string;
  component: ComponentType<{ input: EditorInput }>;
  title: (input: EditorInput) => string;
  icon?: (input: EditorInput) => string;
  /**
   * Its tabs are saved with the editor session and reopened with the project (their
   * `data` must be plain JSON). The editor closes tabs whose target is gone itself.
   */
  restorable?: boolean;
  /**
   * The editor owns a document with unsaved state (a notebook): it takes part in
   * the dirty mark, Save All, autosave and the close prompts. Tabs with equal
   * `input.key` (splits) share one document.
   */
  document?: EditorDocumentLifecycle;
}

/**
 * Document lifecycle of a custom editor kind, keyed by its tabs' input. The
 * workbench calls it whatever React has mounted: hidden tabs keep their
 * document. Call `notifyEditorDocumentChanged` whenever `isDirty` may change.
 */
export interface EditorDocumentLifecycle {
  /** Unsaved changes, pending edits not committed yet included. */
  isDirty(input: EditorInput): boolean;
  /** Commits pending edits; rejects when they can't be. */
  flush(input: EditorInput): Promise<void>;
  /** Flushes and saves; rejects on failure (the document stays dirty and open). */
  save(input: EditorInput): Promise<void>;
  /**
   * Before a close decision: stops admitting edits and runs, flushes, and
   * interrupts and drains execution, so `isDirty` holds until `cancelClose`.
   */
  prepareClose(input: EditorInput): Promise<void>;
  /** The close didn't happen (Cancel, a failed save, a tab of it opened again): edits and runs resume. */
  cancelClose(input: EditorInput): void;
  /** Don't Save: drops unsaved changes without saving them. */
  discard(input: EditorInput): Promise<void>;
  /** Releases the document (and its kernel…) once no tab shows it any more. Called once per open. */
  close(input: EditorInput): Promise<void>;
  /** Edit › Undo / Redo while the editor has focus. */
  undo?(input: EditorInput): Promise<void>;
  redo?(input: EditorInput): Promise<void>;
}

/** Bumped by `notifyEditorDocumentChanged`; selectors reading `isDirty` re-run on it. */
export const useEditorDocuments = create<{ revision: number }>(() => ({ revision: 0 }));

/** A custom editor document's dirty state (or pending edits) may have changed: tab marks and counts refresh. */
export function notifyEditorDocumentChanged() {
  useEditorDocuments.setState((s) => ({ revision: s.revision + 1 }));
}

/** Changes with every `notifyEditorDocumentChanged`, for components that read `isDirty`. */
export function useEditorDocumentRevision(): number {
  return useEditorDocuments((s) => s.revision);
}

/**
 * A view in the Services tool window (IDEA's Services: Docker, HTTP requests,
 * database consoles…), one header tab each.
 */
export interface ServiceViewContribution {
  id: string;
  title: string;
  icon: string;
  /** Tab order; lower first. */
  order?: number;
  component: ComponentType;
  /** Extra Services header controls while this view is selected. */
  headerActions?: ComponentType;
  /** Listed only once shown with `showServiceView` (a request ran…), like `stripe: "onUse"`. */
  onUse?: boolean;
}

/** A node of the Services tree; `key` is unique across providers (prefix it with the provider id). */
export interface ServiceTreeItem {
  key: string;
  label: string;
  icon: string;
  /** Grey text after the label (status, counts…). */
  detail?: string;
  /** Greyed label (stopped, not running). */
  dim?: boolean;
  /** Expanded the first time the node appears. */
  expanded?: boolean;
  /** Undefined for leaves. */
  children?: ServiceTreeItem[];
}

/** A toolbar button the Services tree shows for the selected node. */
export interface ServiceItemAction {
  id: string;
  title: string;
  icon: string;
  disabled?: boolean;
  run(): void;
}

/**
 * Top-level nodes of the Services tree (IDEA's ServiceViewContributor): Docker
 * connections, run configurations… Each provider owns its nodes' toolbar,
 * context menu and detail pane, and adds entries to the "Add Service" menu.
 */
export interface ServiceProviderContribution {
  id: string;
  /** Root order; lower first. */
  order?: number;
  /** React hook: this provider's root nodes (none: nothing shown). */
  useRoots(): ServiceTreeItem[];
  /** Keeps the provider's data live while the tree is shown; returns a disposer. */
  watch?(): () => void;
  /** Toolbar buttons for a selected node of this provider. */
  actions?(item: ServiceTreeItem): ServiceItemAction[];
  menu?(item: ServiceTreeItem): MenuItem[];
  /** Double click / Enter. */
  activate?(item: ServiceTreeItem): void;
  /** Right pane for a selected node. */
  detail?: ComponentType<{ item: ServiceTreeItem }>;
  /** Status line above the tree (a long operation in progress…); renders null when idle. */
  banner?: ComponentType;
  /** Entries of the "Add Service" (+, ⌘N) menu. */
  addMenu?(): MenuItem[];
}

export const useServiceProviders = create<{ providers: Map<string, ServiceProviderContribution> }>(() => ({
  providers: new Map(),
}));

export function registerServiceProvider(p: ServiceProviderContribution): () => void {
  useServiceProviders.setState((s) => ({ providers: new Map(s.providers).set(p.id, p) }));
  return () =>
    useServiceProviders.setState((s) => {
      if (s.providers.get(p.id) !== p) return s;
      const providers = new Map(s.providers);
      providers.delete(p.id);
      return { providers };
    });
}

export function serviceProviders(map = useServiceProviders.getState().providers): ServiceProviderContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

export interface EditorInput {
  kind: string; // "file" for text documents
  /** Stable key; tabs with equal keys are the same tab. */
  key: string;
  path?: string;
  data?: unknown;
}

interface Contributions {
  toolWindows: Map<string, ToolWindowContribution>;
  statusItems: Map<string, StatusItemContribution>;
  overlays: Map<string, OverlayContribution>;
  editorKinds: Map<string, EditorKindContribution>;
  titleItems: Map<string, TitleItemContribution>;
  serviceViews: Map<string, ServiceViewContribution>;
}

export const useContributions = create<Contributions>(() => ({
  toolWindows: new Map(),
  statusItems: new Map(),
  overlays: new Map(),
  editorKinds: new Map(),
  titleItems: new Map(),
  serviceViews: new Map(),
}));

function register<K extends keyof Contributions>(
  key: K,
  id: string,
  value: Contributions[K] extends Map<string, infer V> ? V : never,
) {
  useContributions.setState(
    (s) => ({ [key]: new Map(s[key] as Map<string, unknown>).set(id, value) }) as Partial<Contributions>,
  );
  return () =>
    useContributions.setState((s) => {
      const current = s[key] as Map<string, unknown>;
      // A later registration with the same id replaced this one; leave it.
      if (current.get(id) !== value) return s;
      const next = new Map(current);
      next.delete(id);
      return { [key]: next } as Partial<Contributions>;
    });
}

export const registerToolWindow = (c: ToolWindowContribution) => register("toolWindows", c.id, c);
export const registerStatusItem = (c: StatusItemContribution) => register("statusItems", c.id, c);
export const registerOverlay = (c: OverlayContribution) => register("overlays", c.id, c);
export const registerEditorKind = (c: EditorKindContribution) => register("editorKinds", c.kind, c);
export const registerTitleItem = (c: TitleItemContribution) => register("titleItems", c.id, c);
export const registerServiceView = (c: ServiceViewContribution) => register("serviceViews", c.id, c);

/** The Services tool window, which hosts the service views. */
export const SERVICES_WINDOW = "services";
export const useActiveServiceView = create<{ active: string | null; used: ReadonlySet<string> }>(() => ({
  active: null,
  used: new Set(),
}));

/** Selects a service view and opens the Services tool window. */
export function showServiceView(id: string, focus = false) {
  useActiveServiceView.setState((s) => ({ active: id, used: s.used.has(id) ? s.used : new Set(s.used).add(id) }));
  toolWindowService().show(SERVICES_WINDOW, focus);
}

// ---------------------------------------------------------------------------
// Workbench slots: single components owned by one feature.

interface WorkbenchSlots {
  /** Renders editor tabs + editors (the editor feature). */
  editorArea?: ComponentType;
  /** Shown instead of the workbench when no project is open (recent projects…). */
  welcome?: ComponentType;
  /** The title bar project widget's popup (open / recent projects). */
  projectPopup?: ComponentType<ProjectPopupProps>;
}

export interface ProjectPopupProps {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export const useWorkbenchSlots = create<WorkbenchSlots>(() => ({}));

function provideSlot<K extends keyof WorkbenchSlots>(slot: K, component: NonNullable<WorkbenchSlots[K]>): () => void {
  useWorkbenchSlots.setState({ [slot]: component });
  return () => {
    if (useWorkbenchSlots.getState()[slot] === component) useWorkbenchSlots.setState({ [slot]: undefined });
  };
}

export const provideEditorArea = (component: ComponentType) => provideSlot("editorArea", component);
export const provideWelcomeView = (component: ComponentType) => provideSlot("welcome", component);
export const provideProjectPopup = (component: ComponentType<ProjectPopupProps>) =>
  provideSlot("projectPopup", component);

// ---------------------------------------------------------------------------
// File editors: `openFile` asks providers whether a path opens in another
// editor kind (images, hex view) before the text editor. A provider may probe
// the file (size, binary content); the first non-null answer wins.

/** Resources acquired while resolving belong to the request until its tab is admitted. */
export interface FileEditorResolutionContext {
  /** Commit is synchronous: no close/project transition may interleave with tab insertion. */
  onAdmission(commit: () => void, rollback: () => Promise<void>): void;
}

export interface FileEditorResolution {
  input: EditorInput;
  admit(): void;
  rollback(): Promise<void>;
}

export interface FileEditorProvider {
  id: string;
  /** Lower asks first. Default 100. */
  order?: number;
  resolve(path: string, context: FileEditorResolutionContext): EditorInput | null | Promise<EditorInput | null>;
}

const fileEditorProviders = new Map<string, FileEditorProvider>();

export function registerFileEditorProvider(p: FileEditorProvider): () => void {
  fileEditorProviders.set(p.id, p);
  return () => {
    if (fileEditorProviders.get(p.id) === p) fileEditorProviders.delete(p.id);
  };
}

/** The non-text editor input for `path`, or null for the text editor. Provider failures fall through. */
export async function resolveFileEditor(path: string): Promise<FileEditorResolution | null> {
  const providers = [...fileEditorProviders.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const p of providers) {
    const acquisitions: Array<{ commit: () => void; rollback: () => Promise<void> }> = [];
    let admitted = false;
    const rollback = async () => {
      if (admitted) return;
      const results = await Promise.allSettled(acquisitions.splice(0).map((a) => Promise.resolve().then(a.rollback)));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "File editor acquisition cleanup failed",
        );
    };
    try {
      const input = await p.resolve(path, {
        onAdmission: (commit, release) => acquisitions.push({ commit, rollback: release }),
      });
      if (input)
        return {
          input,
          admit: () => {
            for (const acquisition of acquisitions) acquisition.commit();
            admitted = true;
            acquisitions.length = 0;
          },
          rollback,
        };
    } catch (e) {
      console.warn(`file editor provider ${p.id} failed`, e);
    }
    await rollback();
  }
  return null;
}

/**
 * Text editor wrappers: render around the text editor of matching files, e.g.
 * Markdown's "Editor and Preview" split. The wrapper must render `children`
 * (the editor) at all times, hiding it with CSS when needed, so the document
 * view stays alive.
 */
export interface TextEditorWrapperContribution {
  id: string;
  matches(path: string): boolean;
  component: ComponentType<{ path: string; tabId: string; children: ReactNode }>;
}

export const useTextEditorWrappers = create<{ wrappers: Map<string, TextEditorWrapperContribution> }>(() => ({
  wrappers: new Map(),
}));

export function registerTextEditorWrapper(w: TextEditorWrapperContribution): () => void {
  useTextEditorWrappers.setState((s) => ({ wrappers: new Map(s.wrappers).set(w.id, w) }));
  return () =>
    useTextEditorWrappers.setState((s) => {
      if (s.wrappers.get(w.id) !== w) return s;
      const wrappers = new Map(s.wrappers);
      wrappers.delete(w.id);
      return { wrappers };
    });
}

export function textEditorWrapperFor(
  wrappers: ReadonlyMap<string, TextEditorWrapperContribution>,
  path: string,
): TextEditorWrapperContribution | undefined {
  for (const w of wrappers.values()) if (w.matches(path)) return w;
  return undefined;
}

/**
 * Spread on an element that handles files dropped from the OS itself (copy into
 * a folder, attach to a prompt); the window-wide drop (open in the editor)
 * leaves drops over it alone.
 */
export const OWNS_FILE_DROP = { "data-owns-file-drop": "" } as const;

// ---------------------------------------------------------------------------
// Services implemented by one feature and consumed by others. The provider
// calls `provide*` during activation; consumers call through the accessor.

export interface OpenOptions {
  /** Select / reveal this range (0-based line, UTF-16 col). */
  selection?: { line: number; col: number; endLine?: number; endCol?: number };
  /** Preview tab (replaced by the next preview), like IDEA's preview tab. */
  preview?: boolean;
  /** Open to the side (split right). */
  side?: boolean;
  /** Open in this editor pane, in a tab of its own even when another pane shows the file. */
  pane?: string;
  focus?: boolean;
  /** Open in the text editor even when a file editor provider claims the file (SVG as text). */
  asText?: boolean;
}

export interface OpenEditorTab {
  input: EditorInput;
  title: string;
  icon: string;
  /** Activation order this session (higher is more recent); 0 if never active. */
  lastActive: number;
}

export interface EditorService {
  openFile(path: string, options?: OpenOptions): Promise<void>;
  openInput(input: EditorInput, options?: OpenOptions): Promise<void>;
  /** Path of the focused text editor, if any. */
  activePath(): string | null;
  /** Doc id + cursor of the focused text editor. */
  activeCursor(): { doc: number; path: string; line: number; col: number; offset: number } | null;
  /** Save all dirty documents; rejects with the failures once every save was tried. */
  saveAll(): Promise<void>;
  /** Move keyboard focus to the active editor (used by Escape from tool windows). */
  focus?(): void;
  /** Paths of the documents open in editor tabs (all panes, tab order). */
  openPaths?(): string[];
  /** Every open tab, files or not, most recently active first (Switcher). */
  openTabs?(): OpenEditorTab[];
  /** Input of the active tab (any kind), if any. */
  activeInput?(): EditorInput | null;
  /** Calls `fn` whenever the active tab changes; returns the unsubscribe. */
  onActiveInputChange?(fn: (input: EditorInput | null) => void): () => void;
  /**
   * Closes every tab showing `path`. Tabs without a custom document close at
   * once; unsaved custom documents are asked about first. Resolves false when
   * the user kept them (Cancel, a failed save).
   */
  closePath?(path: string): Promise<boolean>;
  /** Closes the tab of the input with this `key` (e.g. a merge editor once applied), like `closePath`. */
  closeInput?(key: string): Promise<boolean>;
  /** Reformat Code on the whole open document at `path` (quietly); whether anything changed. */
  reformat?(path: string): Promise<boolean>;
  /**
   * Window / project close: prepares every open custom editor document for the
   * Save / Don't Save / Cancel decision (see `EditorCloseSession`).
   */
  prepareClose?(): Promise<EditorCloseSession>;
  /** Backend project/window transition failed after authorization: resume its prepared documents. */
  cancelClose?(): void;
  /** Edit › Undo / Redo for a focused custom editor that has its own history; false when none takes it. */
  documentHistory?(command: "undo" | "redo"): boolean;
}

/** Custom editor documents held still for a window / project close decision. */
export interface EditorCloseSession {
  /** Documents with unsaved changes. */
  dirty: number;
  /** Don't Save: drops their unsaved changes. */
  discard(): Promise<void>;
  /** The close didn't happen (Cancel, a failed save): the documents resume. */
  cancel(): void;
  /** The close goes ahead: they stay held until their tabs close (they resume if the project stays open). */
  commit(): void;
}

export interface ToolWindowService {
  show(id: string, focus?: boolean): void;
  hide(id: string): void;
  toggle(id: string): void;
  isVisible(id: string): boolean;
}

export interface NotificationService {
  notify(n: {
    level: "info" | "warning" | "error";
    title: string;
    body?: ReactNode;
    actions?: Array<{ label: string; run: () => void }>;
    /** Keep the balloon until dismissed (errors are sticky by default). */
    sticky?: boolean;
    /** Replaces an earlier notification with the same key. */
    key?: string;
    /**
     * Notification group (Settings › Notifications): `system` (default), `lsp`,
     * `vcs`, `run`, `tools`, `plugins`, `search`, `updates`.
     */
    group?: string;
  }): void;
  /** Hides the balloon of the notification with `key` (it stays in the log), e.g. once its cause is gone. */
  expire?(key: string): void;
}

/** A terminal widget (xterm) embedded in another view, e.g. a Run console emulating a terminal. */
export interface EmbeddedTerminal {
  write(data: string): void;
  clear(): void;
  focus(): void;
  /** Re-measures the host element (after it was shown or resized). */
  fit(): void;
  dispose(): void;
}

export interface EmbeddedTerminalOptions {
  /** Keystrokes and pastes, as terminal input. */
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  /** Directory relative file links resolve against. */
  cwd?: string;
  "aria-label"?: string;
}

export type EmbeddedTerminalFactory = (
  host: HTMLElement,
  options: EmbeddedTerminalOptions,
) => Promise<EmbeddedTerminal>;

const services: {
  editor?: EditorService;
  toolWindows?: ToolWindowService;
  notifications?: NotificationService;
  embeddedTerminal?: EmbeddedTerminalFactory;
} = {};

function need<T>(s: T | undefined, name: string): T {
  if (!s) throw new Error(`${name} service not provided yet`);
  return s;
}

export const provideEditorService = (s: EditorService) => void (services.editor = s);
export const provideToolWindowService = (s: ToolWindowService) => void (services.toolWindows = s);
export const provideNotificationService = (s: NotificationService) => void (services.notifications = s);
export const provideEmbeddedTerminal = (f: EmbeddedTerminalFactory | undefined) => void (services.embeddedTerminal = f);

export const editorService = (): EditorService => need(services.editor, "editor");
export const toolWindowService = (): ToolWindowService => need(services.toolWindows, "toolWindows");
export const notifications = (): NotificationService =>
  services.notifications ?? { notify: (n) => console.info(`[${n.level}] ${n.title}`) };
/** The editor service if one has been provided (for optional integrations). */
export const maybeEditorService = (): EditorService | undefined => services.editor;
/** Creates terminal widgets; provided by the terminal feature. */
export const embeddedTerminal = (): EmbeddedTerminalFactory | undefined => services.embeddedTerminal;

// ---------------------------------------------------------------------------
// File decorations: colour / badge / tooltip for a path, shown by the project
// tree, editor tabs, Search Everywhere, etc. Providers (VCS status, problems)
// push decorations into this store; consumers read with `useFileDecoration`.

export interface FileDecoration {
  /** CSS colour, normally a token like `var(--vcs-modified)`. */
  color?: string;
  /** CSS colour tinting the editor tab (a data source's colour on its console). */
  tint?: string;
  /** Short badge text, e.g. a problem count. */
  badge?: string;
  tooltip?: string;
  /** Wavy-underline style emphasis for files with errors (IDEA red underline). */
  error?: boolean;
  /** Dim the entry (ignored/excluded). */
  faded?: boolean;
  /** Also decorate ancestor folders (VCS changes, errors). */
  propagate?: boolean;
  /** The path is a folder whose whole content shares this decoration (untracked / ignored folder). */
  subtree?: boolean;
}

interface FileDecorationsState {
  /** provider id → (path → decoration). Later providers win per field. */
  providers: Map<string, Map<string, FileDecoration>>;
  /** Folder paths that contain decorated descendants, per provider. */
  folders: Map<string, Map<string, FileDecoration>>;
  /** `subtree` decorations per provider: folder → decoration for everything below it. */
  subtrees: Map<string, Map<string, FileDecoration>>;
}

export const useFileDecorations = create<FileDecorationsState>(() => ({
  providers: new Map(),
  folders: new Map(),
  subtrees: new Map(),
}));

const providerOrder = ["vcs", "problems"];

/** Replaces all decorations of one provider. */
export function setFileDecorations(provider: string, decorations: Map<string, FileDecoration>) {
  const folders = new Map<string, FileDecoration>();
  const subtrees = new Map<string, FileDecoration>();
  for (const [path, d] of decorations) {
    if (d.subtree) subtrees.set(path, { color: d.color, tooltip: d.tooltip, faded: d.faded, error: d.error });
    if (!d.propagate) continue;
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      const prev = folders.get(dir);
      folders.set(dir, { color: prev?.color ?? d.color, error: prev?.error || d.error });
    }
  }
  useFileDecorations.setState((s) => ({
    providers: new Map(s.providers).set(provider, decorations),
    folders: new Map(s.folders).set(provider, folders),
    subtrees: new Map(s.subtrees).set(provider, subtrees),
  }));
}

/** Nearest `subtree` decoration of an ancestor folder of `path`. */
function inherited(path: string, subtrees: Map<string, FileDecoration> | undefined): FileDecoration | undefined {
  if (!subtrees?.size) return undefined;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const d = subtrees.get(path.slice(0, i));
    if (d) return d;
  }
  return undefined;
}

function merged(path: string, s: FileDecorationsState): FileDecoration | undefined {
  let out: FileDecoration | undefined;
  const ids = [...s.providers.keys()].sort((a, b) => providerOrder.indexOf(a) - providerOrder.indexOf(b));
  for (const id of ids) {
    const d = s.providers.get(id)?.get(path) ?? s.folders.get(id)?.get(path) ?? inherited(path, s.subtrees.get(id));
    if (d) out = { ...out, ...d };
  }
  return out;
}

export function getFileDecoration(path: string): FileDecoration | undefined {
  return merged(path, useFileDecorations.getState());
}

const NONE: FileDecoration = {};

/** Reactive decoration for `path` (empty object when undecorated). */
export function useFileDecoration(path: string): FileDecoration {
  return useFileDecorations(useShallow((s) => merged(path, s) ?? NONE));
}

// ---------------------------------------------------------------------------
// Settings pages, shown in the Settings dialog (⌘,) tree. Features contribute
// their own pages (e.g. Languages & Servers, Plugins); the settings feature
// renders the tree, search and the page host.

export interface SettingsPageContribution {
  /** Dotted path defines nesting, e.g. `languages.servers`. */
  id: string;
  title: string;
  /** Parent group title for top-level grouping, e.g. "Editor", "Tools". */
  group?: string;
  order?: number;
  /** Extra words matched by the settings search. */
  keywords?: string[];
  /** Omitted: the page lists links to its sub-pages. */
  component?: ComponentType;
  /** The page edits settings that a project can override (Global / This project switch). */
  projectScope?: boolean;
}

/**
 * What a settings page edits through: values of the page's scope with the
 * edits not applied yet. Edits are written on Apply / OK and dropped on Cancel.
 */
export interface SettingsForm {
  scope: "global" | "project";
  /** Value of a dotted key (map entries too, e.g. `languageServers.ruff.args`). */
  useValue(key: string): unknown;
  /** Stages a value; `null` removes the key on Apply. */
  set(key: string, value: unknown): void;
}

export const SettingsFormContext = createContext<SettingsForm | null>(null);

/** The form of the settings page being shown (provided by the Settings dialog). */
export function useSettingsForm(): SettingsForm {
  const form = useContext(SettingsFormContext);
  if (!form) throw new Error("useSettingsForm outside a settings page");
  return form;
}

export const useSettingsPages = create<{ pages: Map<string, SettingsPageContribution> }>(() => ({ pages: new Map() }));

export function registerSettingsPage(page: SettingsPageContribution): () => void {
  useSettingsPages.setState((s) => ({ pages: new Map(s.pages).set(page.id, page) }));
  return () =>
    useSettingsPages.setState((s) => {
      if (s.pages.get(page.id) !== page) return s;
      const pages = new Map(s.pages);
      pages.delete(page.id);
      return { pages };
    });
}

/** A searchable settings entry: a page, or an option label on it (Search Everywhere's "Settings: …" items). */
export interface SettingsSearchEntry {
  pageId: string;
  /** Page title or option label. */
  title: string;
  /** Breadcrumb of the page ("Editor", "General"). */
  path: string[];
  /** Extra words that match this entry (page keywords). */
  keywords?: string[];
}

let settingsSearchIndex: (() => Promise<SettingsSearchEntry[]>) | null = null;

/** The settings feature provides its search index (pages load lazily, so it is async). */
export function provideSettingsSearchIndex(index: () => Promise<SettingsSearchEntry[]>): () => void {
  settingsSearchIndex = index;
  return () => {
    if (settingsSearchIndex === index) settingsSearchIndex = null;
  };
}

export function searchableSettings(): Promise<SettingsSearchEntry[]> {
  return settingsSearchIndex ? settingsSearchIndex() : Promise.resolve([]);
}

// ---------------------------------------------------------------------------
// Project view roots shown below the project ("External Libraries", "Scratches").

export interface ProjectViewRootEntry {
  label: string;
  /** Icon name from `ui/icons`. */
  icon: string;
  /** Folder whose contents the node lists (outside the project); omitted for a group of `children`. */
  path?: string;
  /** Child nodes of a group node (one per SDK, then its library folders). */
  children?: readonly ProjectViewRootEntry[];
  /** Grey text after the label ("library root"). */
  detail?: string;
  /** Library sources: shown read-only (no new / rename / move / delete). */
  readOnly?: boolean;
}

export interface ProjectViewRootContribution extends ProjectViewRootEntry {
  id: string;
  /** Lower first. */
  order?: number;
  /** Which project view mode lists it besides "Project" ("Scratches and Consoles"). */
  scope?: "scratches";
}

export const useProjectViewRoots = create<{ roots: Map<string, ProjectViewRootContribution> }>(() => ({
  roots: new Map(),
}));

export function registerProjectViewRoot(root: ProjectViewRootContribution): () => void {
  useProjectViewRoots.setState((s) => ({ roots: new Map(s.roots).set(root.id, root) }));
  return () =>
    useProjectViewRoots.setState((s) => {
      if (s.roots.get(root.id) !== root) return s;
      const roots = new Map(s.roots);
      roots.delete(root.id);
      return { roots };
    });
}

/** Registered project view roots in display order. */
export function projectViewRoots(map: ReadonlyMap<string, ProjectViewRootContribution>): ProjectViewRootContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Context menu groups: features add items to the editor, project view and
// editor tab context menus (IDEA's EditorPopupMenu / ProjectViewPopupMenu /
// EditorTabPopupMenu / EditorGutterPopupMenu groups), e.g. "Run 'hi.ts'" from features/run.
// `openIn` is the Open In › submenu those three menus share (Browser › from features/web).
// `stopProcess` is the Stop chooser (as IDEA): one item per running process
// a feature can stop (features/run: run sessions, features/debugger: debug sessions).
// `selectIn` is the Select In chooser (⌥F1): targets for a file besides the project view.
// `new` is the New popup / New › submenu (IDEA's NewGroup): file kinds a feature creates
// in `paths[0]`, the target directory (features/templates: file templates, http-client: HTTP Request).

export type ContextMenuId =
  | "editor"
  | "projectView"
  | "editorTab"
  | "editorGutter"
  | "openIn"
  | "stopProcess"
  | "selectIn"
  | "new";

export interface MenuGroupContext {
  /** Files / directories the menu is for (absolute paths; a virtual URI for virtual documents). */
  paths: string[];
  /** Per path: whether it is a directory (project view). */
  dirs?: boolean[];
  /** The document text, when the menu is for an open document. */
  text?: string;
  /** Editor menu: 0-based caret line; gutter menu: the clicked line. */
  line?: number;
}

export interface MenuGroupContribution {
  id: string;
  menus: ContextMenuId[];
  /** Lower first. */
  order?: number;
  /** Items for this menu (empty for none); called synchronously while the menu is built. */
  items(menu: ContextMenuId, ctx: MenuGroupContext): MenuItem[];
  /** Optional async preparation before the menu opens (e.g. reading the file), bounded by the caller. */
  prepare?(menu: ContextMenuId, ctx: MenuGroupContext): Promise<void>;
}

const menuGroups = new Map<string, MenuGroupContribution>();

export function registerMenuGroup(group: MenuGroupContribution): () => void {
  menuGroups.set(group.id, group);
  return () => {
    if (menuGroups.get(group.id) === group) menuGroups.delete(group.id);
  };
}

function groupsFor(menu: ContextMenuId): MenuGroupContribution[] {
  return [...menuGroups.values()]
    .filter((g) => g.menus.includes(menu))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/** Contributed items for `menu`, each non-empty group followed by a separator. */
export function menuGroupItems(menu: ContextMenuId, ctx: MenuGroupContext): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groupsFor(menu)) {
    let items: MenuItem[] = [];
    try {
      items = g.items(menu, ctx);
    } catch (e) {
      console.error(`menu group ${g.id} failed`, e);
    }
    if (items.length) out.push(...items, { kind: "separator" });
  }
  return out;
}

// Project view selection, for actions run outside the project view (Find Action,
// main menu) right after it had focus. Provided by features/project-tree.
let projectSelection: (() => string[]) | undefined;

export function provideProjectViewSelection(get: () => string[]): () => void {
  projectSelection = get;
  return () => {
    if (projectSelection === get) projectSelection = undefined;
  };
}

/** Selected project view paths (absolute); empty without a project view. */
export const projectViewSelection = (): string[] => projectSelection?.() ?? [];

/** Runs the groups' `prepare` hooks, giving up after `timeoutMs` so the menu never waits long. */
export async function prepareMenuGroups(menu: ContextMenuId, ctx: MenuGroupContext, timeoutMs = 200): Promise<void> {
  const pending = groupsFor(menu)
    .map((g) => g.prepare?.(menu, ctx).catch(() => undefined))
    .filter((p): p is Promise<void> => !!p);
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(pending), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// Run executors beside Run and Debug (IDEA's "Run with Coverage", "Profile"),
// contributed by features and offered by features/run: the run widget's ⋮
// menu, the gutter ▶ popup and the context menus' "More Run/Debug".

/** What an executor launches for a configuration, and what happens once it exits. */
export interface ExecutorLaunch {
  /** Launched instead of the configuration (the Run tab still shows the configuration). */
  launch: RunConfig;
  /** The process exited (not called when it failed to start). */
  finished(result: { exitCode: number | null; stopped: boolean }): void;
}

export interface RunExecutorContribution {
  /** `coverage`, `profiler`. */
  id: string;
  /** Menu label for a configuration or context, e.g. `Run 'tests' with Coverage`. */
  label(name: string): string;
  icon: string;
  /** Action that runs the selected configuration with this executor (shortcut shown in menus). */
  action: string;
  /** Lower first. */
  order?: number;
  /** Cheap check whether this executor can run `config` (the menu shows it only then). */
  supports(config: RunConfig): boolean;
  /** Plans the launch; null when it can't run (the executor has said why). */
  prepare(config: RunConfig): Promise<ExecutorLaunch | null>;
}

export const useRunExecutors = create<{ executors: Map<string, RunExecutorContribution> }>(() => ({
  executors: new Map(),
}));

export function registerRunExecutor(executor: RunExecutorContribution): () => void {
  useRunExecutors.setState((s) => ({ executors: new Map(s.executors).set(executor.id, executor) }));
  return () =>
    useRunExecutors.setState((s) => {
      if (s.executors.get(executor.id) !== executor) return s;
      const executors = new Map(s.executors);
      executors.delete(executor.id);
      return { executors };
    });
}

/** Registered executors, in order. */
export function runExecutors(map = useRunExecutors.getState().executors): RunExecutorContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Run configuration types (IDEA's "Add New Configuration" list), contributed by
// features and edited by features/run. A type is declarative: its form fields
// write `RunConfig.params`, and `commandLine` turns them into what is launched.

export interface RunConfigTypeField {
  /** Key in `RunConfig.params`. */
  key: string;
  label: string;
  /**
   * `checkbox` values are `"true"` or absent. `output` is read-only text computed by
   * `value` (not stored), with a Copy button (e.g. the JDWP agent for the remote JVM).
   */
  control?: "text" | "textarea" | "select" | "checkbox" | "output";
  mono?: boolean;
  /** Visible lines of a `textarea` (default 4). */
  rows?: number;
  placeholder?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Values offered while typing (e.g. the scripts of detected configurations). */
  suggestions?(configs: readonly RunConfig[], params: Readonly<Record<string, string>>): string[];
  required?: boolean;
  visible?(params: Readonly<Record<string, string>>): boolean;
  /** An `output` field's text. */
  value?(params: Readonly<Record<string, string>>): string;
  /** Why a non-empty value is invalid, or null. */
  validate?(value: string, params: Readonly<Record<string, string>>): string | null;
  /** Shown under the control. */
  hint?: string;
}

export interface RunConfigTypeContribution {
  /** Stored as `RunConfig.kind`. */
  id: string;
  label: string;
  icon: string;
  description?: string;
  /** Parent node in "Add New Configuration" (e.g. `Docker`). */
  group?: string;
  /** Params of a new configuration (before templates apply). */
  defaults?: Readonly<Record<string, string>>;
  fields: readonly RunConfigTypeField[];
  /**
   * What is launched for `params`; null when the type runs no process itself (Compound).
   * `stop`: a shell command line run on Stop before the process is signalled (`docker stop …`).
   */
  commandLine(
    params: Readonly<Record<string, string>>,
  ): { command: string; args: string[]; cwd?: string | null; stop?: string | null } | null;
  /** Params that reproduce a configuration made elsewhere (detection, older files); null when it doesn't fit. */
  paramsFrom?(config: RunConfig): Record<string, string> | null;
  /** The type's fields set the working directory (no separate field). */
  ownsWorkingDirectory?: boolean;
  /** "Emulate terminal in output console" applies (default true). */
  terminal?: boolean;
  /** Adjusts what is launched right before it starts (e.g. the environment selecting a Docker daemon). */
  prepareLaunch?(config: RunConfig): Promise<RunConfig>;
  /**
   * Only Debug applies: the configuration attaches a debugger and launches no process
   * (Remote JVM Debug, Go Remote). `commandLine` returns null.
   */
  debugOnly?: boolean;
  /** `RunConfig.debugAdapter` of a new configuration. */
  debugAdapter?: string;
}

export const useRunConfigTypes = create<{ types: Map<string, RunConfigTypeContribution> }>(() => ({
  types: new Map(),
}));

export function registerRunConfigType(type: RunConfigTypeContribution): () => void {
  useRunConfigTypes.setState((s) => ({ types: new Map(s.types).set(type.id, type) }));
  return () =>
    useRunConfigTypes.setState((s) => {
      if (s.types.get(type.id) !== type) return s;
      const types = new Map(s.types);
      types.delete(type.id);
      return { types };
    });
}

/** Registered configuration types, by label. */
export function runConfigTypes(map = useRunConfigTypes.getState().types): RunConfigTypeContribution[] {
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Occurrence navigators: result views (Find, Usages, Problems, TODO…) let
// Next / Previous Occurrence step through their results from anywhere, the
// editor included. The actions ask the focused, else the last active tool
// window's navigator; the latest registration per tool window wins.

/** 1-based position of the occurrence navigated to, among `total`. */
export interface OccurrenceStep {
  index: number;
  total: number;
}

export interface OccurrenceNavigator {
  /**
   * Selects the next (1) / previous (-1) occurrence and opens it in the editor,
   * focusing the editor only when `focusEditor` (the action ran outside the tool
   * window). `null` when there is none in that direction.
   */
  go(dir: 1 | -1, focusEditor: boolean): OccurrenceStep | null;
}

const occurrenceNavigators = new Map<string, OccurrenceNavigator[]>();

export function registerOccurrenceNavigator(toolWindow: string, nav: OccurrenceNavigator): () => void {
  occurrenceNavigators.set(toolWindow, [...(occurrenceNavigators.get(toolWindow) ?? []), nav]);
  return () => {
    const rest = (occurrenceNavigators.get(toolWindow) ?? []).filter((n) => n !== nav);
    if (rest.length) occurrenceNavigators.set(toolWindow, rest);
    else occurrenceNavigators.delete(toolWindow);
  };
}

export function occurrenceNavigator(toolWindow: string): OccurrenceNavigator | null {
  return occurrenceNavigators.get(toolWindow)?.at(-1) ?? null;
}

/** Registers `nav` (the latest render's) for `toolWindow` while the calling view is mounted. */
export function useOccurrenceNavigator(toolWindow: string, nav: OccurrenceNavigator["go"]) {
  const latest = useRef(nav);
  useEffect(() => {
    latest.current = nav;
  });
  useEffect(
    () => registerOccurrenceNavigator(toolWindow, { go: (dir, focus) => latest.current(dir, focus) }),
    [toolWindow],
  );
}

// ---------------------------------------------------------------------------
// Editor notification banners (IDEA's EditorNotificationProvider): a feature
// answers, per file, with a banner shown above its text editor, or null.

export interface EditorBanner {
  text: string;
  level?: "info" | "warning";
  /** Icon name (`ui/icons`); defaults to the level's icon. */
  icon?: string;
  /** Links on the right ("Install", "Ignore"). */
  actions?: Array<{ label: string; run: () => void }>;
}

export interface EditorBannerContribution {
  id: string;
  /** Lower first. */
  order?: number;
  /** A React hook (may read stores), called for each open text editor's file. */
  useBanner(path: string): EditorBanner | null;
}

export const useEditorBanners = create<{ banners: Map<string, EditorBannerContribution> }>(() => ({
  banners: new Map(),
}));

export function registerEditorBanner(banner: EditorBannerContribution): () => void {
  useEditorBanners.setState((s) => ({ banners: new Map(s.banners).set(banner.id, banner) }));
  return () =>
    useEditorBanners.setState((s) => {
      if (s.banners.get(banner.id) !== banner) return s;
      const banners = new Map(s.banners);
      banners.delete(banner.id);
      return { banners };
    });
}

// ---------------------------------------------------------------------------
// Local changes: the VCS provider publishes its change lists (IDEA's
// ChangeListManager) for features that filter by changed files (TODO › Changes,
// the project view's "All Changed Files"). Unversioned and ignored files belong
// to no list.

export interface LocalChangedFile {
  path: string;
  /** Deleted in the working tree (no longer on disk). */
  deleted?: boolean;
}

export interface LocalChangelist {
  id: string;
  name: string;
  /** New changes go to the active list. */
  active: boolean;
  files: LocalChangedFile[];
}

export const useLocalChanges = create<{ provider: string | null; lists: LocalChangelist[] }>(() => ({
  provider: null,
  lists: [],
}));

/** Replaces the change lists (one VCS provider at a time); the returned function clears them. */
export function setLocalChanges(provider: string, lists: LocalChangelist[]): () => void {
  useLocalChanges.setState({ provider, lists });
  return () => {
    if (useLocalChanges.getState().provider === provider) useLocalChanges.setState({ provider: null, lists: [] });
  };
}

/** Paths of the changed files, of one list (`listId`) or all; `existing` leaves out deleted files. */
export function localChangedPaths(
  lists: readonly LocalChangelist[],
  listId?: string | null,
  existing = false,
): string[] {
  const out: string[] = [];
  for (const l of lists) {
    if (listId && l.id !== listId) continue;
    for (const f of l.files) if (!existing || !f.deleted) out.push(f.path);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Run Anything (⌃⌃) providers: features offer entries for the typed text
// (run configurations, `mvn …` / `gradle …` command lines) and may take over
// running a whole command line; anything else runs as a shell command.

export interface RunAnythingItem {
  /** Stable within the provider. */
  key: string;
  label: string;
  detail?: string;
  icon?: string;
  /** Text put in the field when the item is completed with Tab (default: label). */
  completion?: string;
  run(): void | Promise<void>;
}

export interface RunAnythingProvider {
  id: string;
  /** Group heading, e.g. "Run Configurations". */
  group: string;
  /** Lower first. */
  order?: number;
  /** Matching entries for the field's text (cheap, synchronous). */
  items(query: string): RunAnythingItem[];
  /** Runs `line` when it belongs to this provider (`mvn clean`); false leaves it to the next one. */
  execute?(line: string): boolean | Promise<boolean>;
}

const runAnythingProviders = new Map<string, RunAnythingProvider>();

export function registerRunAnythingProvider(p: RunAnythingProvider): () => void {
  runAnythingProviders.set(p.id, p);
  return () => {
    if (runAnythingProviders.get(p.id) === p) runAnythingProviders.delete(p.id);
  };
}

/** Registered providers in order. */
export function runAnythingProviderList(): RunAnythingProvider[] {
  return [...runAnythingProviders.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Status bar info text (IDEA's status bar message, e.g. "3 of 12" after Next
// Occurrence). Cleared by the next message or after a while.

export const useStatusInfo = create<{ text: string | null; seq: number }>(() => ({ text: null, seq: 0 }));

let statusInfoTimer: ReturnType<typeof setTimeout> | undefined;

export function showStatusInfo(text: string, ms = 8000) {
  clearTimeout(statusInfoTimer);
  const seq = useStatusInfo.getState().seq + 1;
  useStatusInfo.setState({ text, seq });
  statusInfoTimer = setTimeout(() => {
    if (useStatusInfo.getState().seq === seq) useStatusInfo.setState({ text: null });
  }, ms);
}
