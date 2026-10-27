/**
 * Editor extension contract (CodeMirror 6).
 *
 * `editor/core` owns EditorView creation, document sync with the backend,
 * tabs/splits and the base IDEA keymap. Other features (LSP, VCS gutter,
 * breakpoints, inline debug values…) never import editor internals; they
 * contribute CodeMirror extensions per document through this module and read
 * the active editor through `activeEditor()`.
 *
 * Notes for contributors:
 *  - A `TextEditorHandle` exists only while its tab is visible (background tabs
 *    keep just their EditorState); use `onEditorEvent` / `editorsFor` to react.
 *  - Contribution gutters render right of core's line numbers, change lane
 *    (`gutterLaneMarkers`) and fold chevrons, in contribution order.
 *  - Transactions applied from the backend carry `remoteChange`; ones mirrored
 *    from a split pane carry `mirroredChange` (see `isExternalChange`).
 *  - Right-hand overview marks: `scrollbarMarks`; save hooks:
 *    `registerSaveParticipant`; Back/Forward history: `getNavigationHistory`.
 */
import { Annotation, Compartment, Facet, type EditorState, type Extension, type RangeSet, type Transaction } from "@codemirror/state";
import { GutterMarker, ViewPlugin, type EditorView } from "@codemirror/view";
import type { LanguageDescription } from "@codemirror/language";
import { create } from "zustand";
import { maybeEditorService } from "@/workbench/contributions";

export interface EditorDocContext {
  doc: number;
  path: string;
  /** Backend language id, e.g. `rust`. */
  language: string;
  /** `@codemirror/language-data` name, e.g. `Rust`, if any. */
  uiMode: string | null;
  readOnly: boolean;
  /**
   * A read-only virtual document (library class contents from a language
   * server); `path` is then its URI, not a file: skip file-based features
   * (VCS, local history, TODO scanning, breakpoints…).
   */
  virtual?: boolean;
}

export interface EditorContribution {
  id: string;
  /** Lower runs first; affects precedence of keymaps/decorations. Default 100. */
  order?: number;
  /** Return extensions for one editor instance (called on creation). */
  extensions: (ctx: EditorDocContext) => Extension | Extension[];
  /**
   * Also applies to editable editors outside editor/core (the diff viewer's
   * editable side, the merge result), which get `doc: -1`. Default false.
   */
  embedded?: boolean;
}

export interface TextEditorHandle {
  view: EditorView;
  ctx: EditorDocContext;
}

interface EditorRegistry {
  contributions: Map<string, EditorContribution>;
  /** Focused text editor, or the last focused one when focus is elsewhere. */
  active: TextEditorHandle | null;
  /** All live text editors (one per visible editor pane). */
  editors: Set<TextEditorHandle>;
}

export const useEditorRegistry = create<EditorRegistry>(() => ({
  contributions: new Map(),
  active: null,
  editors: new Set(),
}));

/**
 * Registers per-editor extensions. Existing editors are reconfigured by
 * editor/core when contributions change (via a Compartment), so features may
 * register at any time.
 */
export function registerEditorContribution(c: EditorContribution): () => void {
  useEditorRegistry.setState((s) => ({ contributions: new Map(s.contributions).set(c.id, c) }));
  return () =>
    useEditorRegistry.setState((s) => {
      const contributions = new Map(s.contributions);
      contributions.delete(c.id);
      return { contributions };
    });
}

export function editorContributions(): EditorContribution[] {
  return [...useEditorRegistry.getState().contributions.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

const embeddedCompartment = new Compartment();
const embeddedViews = new Map<EditorView, EditorDocContext>();

function embeddedContributions(ctx: EditorDocContext): Extension[] {
  const out: Extension[] = [];
  for (const c of editorContributions()) {
    if (!c.embedded) continue;
    try {
      out.push(c.extensions(ctx));
    } catch (e) {
      console.error(`editor contribution ${c.id} failed`, e);
    }
  }
  return out;
}

/**
 * Contributions flagged `embedded` for an editable editor that editor/core
 * does not own (diff viewer, merge result). Reconfigured live when
 * contributions change.
 */
export function embeddedEditorExtensions(path: string): Extension {
  const ctx: EditorDocContext = { doc: -1, path, language: "", uiMode: null, readOnly: false };
  return [
    embeddedCompartment.of(embeddedContributions(ctx)),
    ViewPlugin.define((view) => {
      embeddedViews.set(view, ctx);
      return { destroy: () => void embeddedViews.delete(view) };
    }),
  ];
}

const embeddedOf = (m: Map<string, EditorContribution>) => [...m.values()].filter((c) => c.embedded);

useEditorRegistry.subscribe((s, prev) => {
  if (s.contributions === prev.contributions) return;
  const now = embeddedOf(s.contributions);
  const before = embeddedOf(prev.contributions);
  if (now.length === before.length && now.every((c, i) => c === before[i])) return;
  for (const [view, ctx] of embeddedViews)
    view.dispatch({ effects: embeddedCompartment.reconfigure(embeddedContributions(ctx)) });
});

export function activeEditor(): TextEditorHandle | null {
  return useEditorRegistry.getState().active;
}

/** Editors currently showing `path` (split panes may show the same file). */
export function editorsFor(path: string): TextEditorHandle[] {
  return [...useEditorRegistry.getState().editors].filter((e) => e.ctx.path === path);
}

// --- called by editor/core only ---------------------------------------------

export function _setActiveEditor(handle: TextEditorHandle | null) {
  useEditorRegistry.setState({ active: handle });
}

export function _addEditor(handle: TextEditorHandle) {
  useEditorRegistry.setState((s) => ({ editors: new Set(s.editors).add(handle) }));
}

export function _removeEditor(handle: TextEditorHandle) {
  useEditorRegistry.setState((s) => {
    const editors = new Set(s.editors);
    editors.delete(handle);
    return { editors, active: s.active === handle ? null : s.active };
  });
}

// ===========================================================================
// Additive extension points (owned by editor/core). Everything below is safe to
// use from any feature; none of it requires importing editor internals.
// ===========================================================================

/**
 * Set on transactions that editor/core applies on behalf of the backend
 * (`docPatched` events, resync after `outOfSync`). Such changes are already in
 * the backend document; don't react to them as user typing (e.g. don't trigger
 * completion).
 */
export const remoteChange = Annotation.define<boolean>();

/**
 * Set on transactions mirrored from another view of the same document (split
 * panes share one document model; each pane has its own selection/undo).
 */
export const mirroredChange = Annotation.define<boolean>();

/**
 * Provided by editor/core per editor: resolves once the editor's local edits
 * reached the backend document. Language-server requests read the backend's
 * copy, so position-based requests that edit (format, rename) await it first.
 */
export const documentSynced = Facet.define<() => Promise<void>, (() => Promise<void>) | null>({
  combine: (values) => values[0] ?? null,
});

export function whenSynced(view: EditorView): Promise<void> {
  return view.state.facet(documentSynced)?.() ?? Promise.resolve();
}

/** True for doc changes that did not originate from typing in *this* view. */
export function isExternalChange(tr: Transaction): boolean {
  return !!tr.annotation(remoteChange) || !!tr.annotation(mirroredChange);
}

/**
 * A mark in the editor's right-hand overview lane (the 10px strip over the
 * scrollbar, as in IDEA). Positions are document offsets of the state the
 * facet value was computed for; editor/core maps them to the lane height.
 *
 *   const marks = StateField.define<ScrollbarMark[]>({ … });
 *   registerEditorContribution({ id: "vcs.marks", extensions: () => [
 *     marks, scrollbarMarks.from(marks) ] });
 */
export interface ScrollbarMark {
  from: number;
  /** End offset; marks spanning several lines become taller. Defaults to `from`. */
  to?: number;
  /** CSS colour, normally a token such as `var(--danger)`. */
  color: string;
  /** `line` (default): 4px-wide bar on the lane; `thin`: 2px bar (search hits, occurrences). */
  kind?: "line" | "thin";
  /** Shown on hover. */
  tooltip?: string;
  /** Higher wins when marks overlap. Default 0. */
  priority?: number;
}

export const scrollbarMarks = Facet.define<readonly ScrollbarMark[], readonly ScrollbarMark[]>({
  combine: (values) => (values.length === 1 ? values[0]! : values.flat()),
});

/**
 * The 3px change-marker lane right of the line numbers (VCS added / modified /
 * deleted bars, as in the design). Provide a `RangeSet<GutterMarker>` whose
 * markers start at line starts; `LaneMarker` draws the bar:
 *
 *   gutterLaneMarkers.compute([hunksField], (s) => RangeSet.of(
 *     s.field(hunksField).map((h) => new LaneMarker("var(--gutter-added)").range(s.doc.line(h.line + 1).from))))
 *
 * Several providers are layered (later ones on top).
 */
export const gutterLaneMarkers = Facet.define<RangeSet<GutterMarker>>();

/** Marker for `gutterLaneMarkers`: a solid 3px bar (or a small wedge for `deleted`). */
export class LaneMarker extends GutterMarker {
  constructor(
    readonly color: string,
    readonly kind: "bar" | "deleted" = "bar",
    readonly title?: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof LaneMarker && other.color === this.color && other.kind === this.kind && other.title === this.title;
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = this.kind === "deleted" ? "cm-openidea-laneDeleted" : "cm-openidea-laneBar";
    el.style.setProperty("--lane-color", this.color);
    if (this.title) el.title = this.title;
    return el;
  }
}

// --- language support without a language server ----------------------------------

/**
 * Language-data keys through which a feature answers editor requests for its
 * documents before the language server is asked (the database console's SQL):
 *
 *   EditorState.languageData.of(() => [{ [CONTRIBUTED_HOVER]: sqlHover }])
 */
export const CONTRIBUTED_FORMAT = "openideaFormat";
export const CONTRIBUTED_DEFINITION = "openideaDefinition";
export const CONTRIBUTED_HOVER = "openideaHover";

/** Reformat Code: replacements for `range` (the selection) or the whole document. */
export type ContributedFormatter = (
  state: EditorState,
  range: { from: number; to: number } | null,
) => Array<{ from: number; to: number; insert: string }>;
/** Go to Declaration / ⌘-click: `true` when it handled `pos`. */
export type ContributedDefinition = (view: EditorView, pos: number) => boolean;
/** Hover and Quick Documentation: Markdown about the symbol at `pos`. */
export type ContributedHover = (state: EditorState, pos: number) => { from: number; to: number; markdown: string } | null;

export function contributedAt<T>(state: EditorState, key: string, pos: number): T | undefined {
  return state.languageDataAt<T>(key, pos)[0];
}

// --- navigation history ------------------------------------------------------

/** One entry of the Back/Forward (⌘[ / ⌘]) history. 0-based line, UTF-16 col. */
export interface NavigationLocation {
  path: string;
  line: number;
  col: number;
  /** `Date.now()` when the location was last visited. */
  time: number;
}

export interface NavigationHistorySnapshot {
  /** Oldest first. */
  entries: NavigationLocation[];
  /** Index of the current location in `entries` (-1 when empty). */
  index: number;
}

let navigationHistoryProvider: (() => NavigationHistorySnapshot) | null = null;

/** Location history recorded by editor/core (file switches and big caret jumps). */
export function getNavigationHistory(): NavigationHistorySnapshot {
  return navigationHistoryProvider?.() ?? { entries: [], index: -1 };
}

/** @internal editor/core only. */
export function _provideNavigationHistory(provider: () => NavigationHistorySnapshot) {
  navigationHistoryProvider = provider;
}

// --- editor events ------------------------------------------------------------

export type EditorEvent =
  | { type: "docOpened"; doc: number; path: string; language: string }
  | { type: "docClosed"; doc: number; path: string }
  /** After the backend wrote the file. */
  | { type: "docSaved"; doc: number; path: string }
  /** The active (focused or last focused) editor tab changed; `path` is null for non-file tabs. */
  | { type: "activeEditorChanged"; path: string | null; doc: number | null }
  /** Caret moved in the active text editor (throttled to animation frames). 0-based. */
  | { type: "caretMoved"; doc: number; path: string; line: number; col: number; offset: number };

type EditorEventListener = (e: EditorEvent) => void;
const editorEventListeners = new Set<EditorEventListener>();

export function onEditorEvent(listener: EditorEventListener): () => void {
  editorEventListeners.add(listener);
  return () => editorEventListeners.delete(listener);
}

/** @internal editor/core only. */
export function _emitEditorEvent(e: EditorEvent) {
  for (const l of [...editorEventListeners]) {
    try {
      l(e);
    } catch (err) {
      console.error("editor event listener failed", err);
    }
  }
}

// --- save participants ----------------------------------------------------------

/**
 * Runs before a document is written (format on save, organise imports…).
 * Participants may edit the document through `handle.view` (normal
 * transactions); editor/core waits for them, then trims whitespace / adds the
 * final newline per settings, flushes the edit pipeline and saves. `handle`
 * is null when no editor shows the document. Keep them fast; failures are
 * logged and do not block saving.
 */
export interface SaveParticipant {
  id: string;
  /** Lower runs first. Default 100. */
  order?: number;
  /** `explicit` = ⌘S / Save All; participants are not run for autosave. */
  beforeSave: (ctx: EditorDocContext, handle: TextEditorHandle | null, reason: "explicit") => Promise<void> | void;
}

const saveParticipants = new Map<string, SaveParticipant>();

export function registerSaveParticipant(p: SaveParticipant): () => void {
  saveParticipants.set(p.id, p);
  return () => {
    if (saveParticipants.get(p.id) === p) saveParticipants.delete(p.id);
  };
}

/** @internal editor/core only. */
export function _saveParticipants(): SaveParticipant[] {
  return [...saveParticipants.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

// --- helpers ------------------------------------------------------------------

/**
 * Opens `path` (if needed) and selects/reveals `range` (0-based line, UTF-16
 * col), recording a navigation history entry. Equivalent to
 * `editorService().openFile(path, { selection })`.
 */
export async function revealRange(
  path: string,
  range: { start: { line: number; col: number }; end?: { line: number; col: number } },
  options: { preview?: boolean; focus?: boolean } = {},
): Promise<void> {
  const service = maybeEditorService();
  if (!service) return;
  await service.openFile(path, {
    ...options,
    selection: { line: range.start.line, col: range.start.col, endLine: range.end?.line, endCol: range.end?.col },
  });
}

// --- code lenses -----------------------------------------------------------------

/**
 * A code lens: a small clickable hint line rendered above a declaration, like
 * IDEA's "3 usages" / "Run test" inlays. Several providers may contribute
 * lenses for the same line; editor/core renders them in one row ordered by
 * `order`. Positions are document offsets of the state the facet value was
 * computed for (any offset on the target line).
 *
 *   const lenses = StateField.define<CodeLens[]>({ … map through changes … });
 *   registerEditorContribution({ id: "run.lens", extensions: () => [
 *     lenses, codeLenses.from(lenses) ] });
 */
export interface CodeLens {
  pos: number;
  title: string;
  tooltip?: string;
  /** Icon name from `ui/icons`. */
  icon?: string;
  /** Click handler; lenses without one render as plain text. */
  run?: (view: EditorView, event: MouseEvent) => void;
  /** Lower first within a line. Default 100. */
  order?: number;
}

export const codeLenses = Facet.define<readonly CodeLens[], readonly CodeLens[]>({
  combine: (values) => (values.length === 1 ? values[0]! : values.flat()),
});

// --- open editors -------------------------------------------------------------------

let openPathsProvider: (() => string[]) | null = null;

/** Paths of every file open in an editor tab (all panes, visual order, unique). */
export function openEditorPaths(): string[] {
  return openPathsProvider?.() ?? [];
}

/** @internal editor/core only. */
export function _provideOpenEditorPaths(provider: () => string[]) {
  openPathsProvider = provider;
}

// --- library sources -----------------------------------------------------------------

const libraryRoots = new Map<string, readonly string[]>();

/**
 * Folders of library / SDK sources ("External Libraries") contributed by `owner`;
 * files below them open read-only, like IDEA's library sources. Replaces the
 * owner's previous roots; returns a disposer.
 */
export function setLibraryRoots(owner: string, roots: readonly string[]): () => void {
  libraryRoots.set(owner, roots);
  return () => {
    if (libraryRoots.get(owner) === roots) libraryRoots.delete(owner);
  };
}

export function isLibraryPath(path: string): boolean {
  for (const roots of libraryRoots.values())
    for (const r of roots) if (path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`)) return true;
  return false;
}

// --- documents shown outside editor tabs ---------------------------------------

/**
 * A live view of an open document for a CodeMirror view that is not an editor
 * tab (e.g. the editable side of a diff). Edits sync both ways with the
 * document shared by all editors of the file, go to the backend, and are saved
 * by Save All; the view keeps its own undo history, like a split pane.
 */
export interface DocumentAttachment {
  path: string;
  /** Current document text; build the view's state from it. */
  text(): string;
  readOnly: boolean;
  /** Add to the view (one view at a time). */
  extension: Extension;
  save(): Promise<void>;
  /** Detach; the document closes when nothing else shows it. */
  release(): void;
}

let documentAttacher: ((path: string) => Promise<DocumentAttachment>) | null = null;

/** Opens (or joins) the document of `path` for a non-tab view. */
export function attachDocument(path: string): Promise<DocumentAttachment> {
  if (!documentAttacher) return Promise.reject(new Error("editor not started"));
  return documentAttacher(path);
}

/** Called by editor/core only. */
export function _provideDocumentAttacher(attacher: ((path: string) => Promise<DocumentAttachment>) | null) {
  documentAttacher = attacher;
}

// --- language modes -------------------------------------------------------------

/**
 * Highlighting modes contributed by features, by `ui-mode` name (the
 * `languages/<id>.toml` key). A registered mode wins over the
 * `@codemirror/language-data` entry of the same name, e.g. the HTTP Client's
 * `.http` request file mode.
 */
const languageModes = new Map<string, LanguageDescription>();

export function registerLanguageMode(desc: LanguageDescription): () => void {
  languageModes.set(desc.name, desc);
  return () => {
    if (languageModes.get(desc.name) === desc) languageModes.delete(desc.name);
  };
}

/** @internal editor/core only. */
export function _languageMode(name: string): LanguageDescription | undefined {
  return languageModes.get(name);
}

// --- read-only code previews ------------------------------------------------------

let codePreviewProvider: ((path: string) => Promise<Extension>) | null = null;

/**
 * Extensions for a read-only CodeMirror view showing `path` like an editor tab
 * (editor font and colours, line numbers, syntax highlighting): previews
 * outside editor tabs such as Find in Files. Empty before editor/core starts.
 */
export function codePreviewExtensions(path: string): Promise<Extension> {
  return codePreviewProvider ? codePreviewProvider(path) : Promise.resolve([]);
}

/** @internal editor/core only. */
export function _provideCodePreview(provider: ((path: string) => Promise<Extension>) | null) {
  codePreviewProvider = provider;
}
