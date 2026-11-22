/** Diff viewer editor tab (side-by-side / unified) built on @codemirror/merge. */
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, Prec, Text, type Extension } from "@codemirror/state";
import { history, historyKeymap } from "@codemirror/commands";
import {
  MergeView,
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  unifiedMergeView,
  uncollapseUnchanged,
  Chunk,
} from "@codemirror/merge";
import { attachDocument, diffSideExtensions, embeddedEditorExtensions, type DocumentAttachment } from "@/editor/api";
import { findChangedRanges, setFindOpen } from "@/editor/core/cm/find";
import { softWrapActive } from "@/editor/core/cm/prefs";
import { FindPanel, searchAgain, seedFind, type FindTarget } from "@/editor/core/view/FindBar";
import { executeAction, getAction } from "@/platform/actions";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { getContext, setContext } from "@/platform/context";
import { editorPrefs } from "@/platform/editorSettings";
import { call, commands } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, shortcutLabel, strokeOf } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { isRemoteWindow } from "@/platform/remote";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { IconButton, Select, Spinner, T, isPopupOpen, showContextMenu } from "@/ui";
import { registerSoftWrapSurface } from "@/workbench/softWrap";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import {
  changedLineGutters,
  diffOverview,
  diffWords,
  documentTooltips,
  firstLineOf,
  languageFor,
  viewerBase,
} from "./cm";
import { collapsedDiffLines } from "./collapsedDiffLines";
import { applyChunk, arrowControls, chunkAt, hoverRevert, onHunkButtonClick, revertUnifiedChunk } from "./diffControls";
import {
  HIGHLIGHT_OPTIONS,
  IGNORE_OPTIONS,
  ideaDiffConfig,
  loadDiffOptions,
  saveDiffOptions,
  getDiffInsights,
  type DiffMode,
  type DiffViewOptions,
  type HighlightPolicy,
  type IgnorePolicy,
} from "./diffOptions";
import {
  chainNeighbour,
  diffTitle,
  detectLineEnding,
  liveSideText,
  lineEndingBadge,
  isIndex,
  isWorktree,
  loadSide,
  loadSideMode,
  oneSided,
  openDiff,
  rememberDiffCaret,
  sideFile,
  sideKey,
  sideLabel,
  type DiffData,
  type DiffSide,
} from "./diffInput";
import { diffAnnotations } from "./diffAnnotations";
import { setAllInOneDiff } from "./allInOneDiff";
import { annotationsShown, blameSlot, toggleAnnotations } from "./blame";
import { diffBlameTarget } from "./diffBlame";
import { changedChainNeighbour } from "./diffNavigation";
import { movedCodeHighlights } from "./movedCode";
import {
  createDiffViewerContributions,
  type DiffPaneSide,
  type DiffViewerContribution,
  type DiffViewerHost,
  type DiffViewerPane,
} from "./diffViewerProviders";
import { PaddedPanes, UnalignedPanes, type DiffPanes } from "./diffScroll";
import { groupOf } from "./changes";
import { inclusionGutter } from "./hunkInclusion";
import { hunksOverlapping } from "./hunks";
import { baseName, effectiveKind, stripSlash } from "./model";
import { errorMessage, logConsole, readWorkingText, runOp, saveAll } from "./ops";
import { refreshNow, repoOf, useVcs } from "./store";
import styles from "./DiffEditor.module.css";

/** Commands of the focused diff viewer (diff.* actions, vcs.nextChange / prevChange). */
export { focusedDiffNavigator, type DiffNavigator };

interface Views {
  /** The right / unified editor (chunks live here). */
  b: EditorView;
  a: EditorView | null;
  merge: MergeView | null;
  /** The panes' scroll machinery: unpadded panes sync through the changes, padded ones copy their scroll. */
  panes: DiffPanes | null;
  destroy(): void;
}

interface Attached {
  a: DocumentAttachment | null;
  b: DocumentAttachment | null;
}

/** 0-based line ranges of a chunk on both sides. */
export function chunkLines(chunk: Chunk, a: Text, b: Text) {
  const range = (from: number, to: number, end: number, doc: Text) => {
    const start = doc.lineAt(Math.min(from, doc.length)).number - 1;
    return from >= to ? [start, start] : [start, doc.lineAt(Math.min(end, doc.length)).number];
  };
  const [fromA, toA] = range(chunk.fromA, chunk.toA, chunk.endA, a);
  const [fromB, toB] = range(chunk.fromB, chunk.toB, chunk.endB, b);
  return { fromA: fromA!, toA: toA!, fromB: fromB!, toB: toB! };
}

/** The 0-based line of `to` matching `line` of `from`, given the chunks between them. */
export function mapLine(chunks: readonly Chunk[], line: number, from: Text, to: Text): number {
  const span = (start: number, end: number, doc: Text) => {
    const first = doc.lineAt(Math.min(start, doc.length)).number - 1;
    return [first, end > start ? doc.lineAt(Math.min(end - 1, doc.length)).number : first] as const;
  };
  let shift = 0;
  for (const c of chunks) {
    const [fromA, toA] = span(c.fromA, c.toA, from);
    if (line < fromA) break;
    const [fromB, toB] = span(c.fromB, c.toB, to);
    if (line < toA) return Math.min(fromB + (line - fromA), Math.max(fromB, toB - 1));
    shift = toB - toA;
  }
  return Math.max(0, Math.min(line + shift, to.lines - 1));
}

/** `chunks` seen from the right side (B ↔ A swapped), for `mapLine` from right to left. */
const swapped = (chunks: readonly Chunk[]) =>
  chunks.map((c) => ({ fromA: c.fromB, toA: c.toB, fromB: c.fromA, toB: c.toA }) as unknown as Chunk);

/** Selects `pos` and scrolls it to the middle, first expanding the collapsed unchanged lines holding it. */
function revealPos(v: EditorView, pos: number) {
  const block = v.lineBlockAt(pos);
  const collapsed = v.state.doc.lineAt(block.from).number !== v.state.doc.lineAt(block.to).number;
  v.dispatch({
    selection: { anchor: pos },
    effects: [
      ...(collapsed ? [uncollapseUnchanged.of(block.from)] : []),
      EditorView.scrollIntoView(pos, { y: "center" }),
    ],
  });
}

/** The panes as diff viewer contributions see them. */
function viewerHost(views: Views, data: DiffData, mode: DiffMode, focused: () => "a" | "b"): DiffViewerHost {
  const docA = () => views.a?.state.doc ?? getOriginalDoc(views.b.state);
  const chunks = () => getChunks(views.b.state)?.chunks ?? [];
  const panes = (): DiffViewerPane[] =>
    views.a
      ? [
          { side: "left", view: views.a },
          { side: "right", view: views.b },
        ]
      : [{ side: "right", view: views.b }];
  const mapSide = (from: DiffPaneSide, line: number) =>
    from === "left"
      ? mapLine(chunks(), line, docA(), views.b.state.doc)
      : mapLine(swapped(chunks()), line, views.b.state.doc, docA());
  const locate = (side: DiffPaneSide, line: number) => {
    const all = panes();
    if (side === "left" && !views.a) return { pane: all[0]!, line: mapSide("left", line) };
    const pane = all.find((p) => p.side === side)!;
    return line >= 0 && line < pane.view.state.doc.lines ? { pane, line } : null;
  };
  return {
    data,
    mode,
    panes,
    doc: (side) => (side === "left" ? docA() : views.b.state.doc),
    mapLine: mapSide,
    locate,
    reveal(side, line) {
      const at = locate(side, line);
      if (!at) return;
      const v = at.pane.view;
      revealPos(v, v.state.doc.line(at.line + 1).from);
      v.focus();
    },
    focusedPane: () => {
      const all = panes();
      return focused() === "a" && views.a ? all[0]! : all[all.length - 1]!;
    },
  };
}

const NO_CONTRIBUTIONS: DiffViewerContribution[] = [];
/** A file without a language; one value, so finding none again doesn't rebuild the views. */
const NO_LANGUAGE: Extension = [];

/** Joins the open document of a file-backed side (working file, Compare Files); null for revisions / texts. */
async function attachSide(side: DiffSide, path: string): Promise<DocumentAttachment | null> {
  const file = sideFile(side, path);
  if (!file) return null;
  try {
    return await attachDocument(file);
  } catch {
    return null;
  }
}

const editableExtensions = (): Extension => [history(), keymap.of(historyKeymap)];

/** The request's side a pane shows: `a` is the left one unless the sides are swapped. */
const originOf = (s: Side, swapped: boolean): "left" | "right" => ((s === "a") !== swapped ? "left" : "right");

/** A side the user types into in the diff itself (Open Blank Diff Window). */
const isEditableText = (s: DiffSide) => s.type === "text" && !!s.editable;

/** The changed ranges of a diff pane, for the find bar's Search In Changes. */
const changedRanges = findChangedRanges.of((state) => {
  const got = getChunks(state);
  if (!got) return [];
  const len = state.doc.length;
  return got.chunks.map((c) =>
    got.side === "a"
      ? { from: c.fromA, to: Math.min(Math.max(c.endA, c.fromA), len) }
      : { from: c.fromB, to: Math.min(Math.max(c.endB, c.fromB), len) },
  );
});

type Side = "a" | "b";
type ViewUpdateFn = (u: { docChanged: boolean; selectionSet: boolean }) => void;

/** Esc alone, not while composing text. */
const plainEscape = (e: KeyboardEvent) =>
  e.key === "Escape" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing;

/** Whether `e` is one of the strokes bound to `actionId`. */
function isStrokeOf(e: KeyboardEvent, actionId: string): boolean {
  const stroke = strokeOf(e.nativeEvent);
  return !!stroke && bindingsFor(actionId).some((b) => normalizeBinding(b) === stroke);
}

/**
 * The typed text of editable text sides (by the request's side), per diff request: it outlives
 * rebuilt views and the editor unmounting while its tab is hidden.
 */
const typedSides = new WeakMap<DiffData, { left?: Text; right?: Text }>();

function typedSidesOf(data: DiffData): { left?: Text; right?: Text } {
  let typed = typedSides.get(data);
  if (!typed) typedSides.set(data, (typed = {}));
  return typed;
}

export function DiffEditor({
  input,
  toolbarActions,
  onNeighbour,
  onJumpToSource,
  onClose,
  fit = false,
}: {
  input: EditorInput;
  toolbarActions?: ReactNode;
  /**
   * Called to show another file of the chain instead of `openDiff` (which opens an
   * editor tab): embedded hosts such as the Commit dialog's diff window swap their
   * own content, as a modal dialog hides the editor area.
   */
  onNeighbour?: (data: DiffData) => void;
  /** Called as Jump to Source opens the file in an editor: a modal host closes, or the editor stays hidden behind it. */
  onJumpToSource?: () => void;
  /** Closes the diff's editor tab (Esc, IDEA's Close Diff Editor); hosts that aren't tabs leave it out. */
  onClose?: () => void;
  /**
   * A block of the all-in-one diff: as tall as its content (the host scrolls), without the
   * toolbar, side-by-side panes always aligned, and not taking the editor tab's focus.
   */
  fit?: boolean;
}) {
  const input_ = input.data as DiffData;
  // Read by the panes' listeners, which outlive a render.
  const inputKey = useRef(input.key);
  inputKey.current = input.key;
  // Swap Sides shows the request's sides the other way round; another request starts unswapped.
  const [swappedFor, setSwappedFor] = useState<DiffData | null>(null);
  const swapped = swappedFor === input_;
  const data = useMemo(
    () => (swapped ? { ...input_, left: input_.right, right: input_.left } : input_),
    [input_, swapped],
  );
  const { path, left, right } = data;
  const edited = typedSidesOf(input_);
  const editedText = (s: Side) => edited[originOf(s, swapped)]?.toString();
  const [attached, setAttached] = useState<Attached | null>(null);
  const [binary, setBinary] = useState<boolean | null>(null);
  /** Text of the sides that are not live documents. */
  const [statics, setStatics] = useState<{ a: string | null; b: string | null } | null>(null);
  /** Git modes of the two sides (`100644`…), for the mode-only-change notice. */
  const [modes, setModes] = useState<{ a: string | null; b: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opts, setOptsState] = useState<DiffViewOptions>(() => {
    const saved = loadDiffOptions();
    return data.mode ? { ...saved, mode: data.mode } : saved;
  });
  // An added or deleted file shows its one side alone, full width (IDEA's one-side viewer):
  // the unified layout of an empty side is exactly that. The saved mode stays as it is.
  const single = oneSided(data);
  const viewMode: DiffMode = single ? "unified" : opts.mode;
  /** Side-by-side panes padded to line up; a fitted block always is (its host scrolls, not the panes). */
  const aligned = fit || opts.alignChanges;
  const [lang, setLang] = useState<Extension | null>(null);
  const [chunkInfo, setChunkInfo] = useState({ count: 0, current: -1, moves: 0, whitespaceOnly: false });
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<Views | null>(null);
  const staticsRef = useRef(statics);
  const focusedSide = useRef<Side>("b");
  /** Bumped when the views are rebuilt, so the find bar re-applies its query. */
  const [viewsGen, setViewsGen] = useState(0);
  const version = useVcs((s) => s.version);
  const heads = useVcs((s) => s.heads);
  const leftKey = sideKey(left);
  const rightKey = sideKey(right);
  const contextKey = JSON.stringify(data.context ?? null);
  const dataRef = useRef(data);
  dataRef.current = data;
  /** Diff viewer providers' contributions for this diff (`registerDiffViewerProvider`). */
  const [contribs, setContribs] = useState<DiffViewerContribution[]>(NO_CONTRIBUTIONS);
  const viewerRef = useRef<DiffViewerHost | null>(null);
  const [viewer, setViewer] = useState<DiffViewerHost | null>(null);
  useEffect(() => {
    const list = createDiffViewerContributions(dataRef.current);
    setContribs(list.length ? list : NO_CONTRIBUTIONS);
    return () => {
      list.forEach((c) => c.dispose?.());
      setContribs(NO_CONTRIBUTIONS);
    };
  }, [path, leftKey, rightKey, contextKey]);

  // A host that picks the layout (the all-in-one diff's toolbar) switches it in place.
  const asked = input_.mode;
  useEffect(() => {
    if (asked) setOptsState((o) => (o.mode === asked ? o : { ...o, mode: asked }));
  }, [asked]);
  const setOpts = (patch: Partial<DiffViewOptions>) =>
    setOptsState((o) => {
      const next = { ...o, ...patch };
      saveDiffOptions(next);
      return next;
    });

  // Live documents for file-backed sides (edits sync with editors, undo, save).
  useEffect(() => {
    let alive = true;
    let got: Attached | null = null;
    void Promise.all([attachSide(left, path), attachSide(right, path)]).then(([a, b]) => {
      got = { a, b };
      if (alive) setAttached(got);
      else {
        a?.release();
        b?.release();
      }
    });
    return () => {
      alive = false;
      got?.a?.release();
      got?.b?.release();
      setAttached(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, leftKey, rightKey]);

  const reload = useCallback(async () => {
    if (!attached) return;
    try {
      const paths = [sideFile(left, path), sideFile(right, path)].filter((p): p is string => !!p);
      const [a, b, modeA, modeB, probes] = await Promise.all([
        attached.a ? null : loadSide(path, left),
        attached.b ? null : loadSide(path, right),
        loadSideMode(path, left),
        loadSideMode(path, right),
        Promise.all(paths.map((p) => call(commands.fsProbe(p)).catch(() => null))),
      ]);
      const prev = staticsRef.current;
      if (!prev || prev.a !== a || prev.b !== b) {
        staticsRef.current = { a, b };
        setStatics({ a, b });
      }
      setModes({ a: modeA, b: modeB });
      setBinary(probes.some((p) => p?.binary));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, leftKey, rightKey, attached]);

  // Initial load and reload whenever repository state changes (staging, commits…).
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload, version]);

  // The file's language as its editor resolves it, from the shown text's first line too
  // (hashbang-only scripts): the right side's, or the left one's when the file is deleted.
  const firstLine = useMemo(() => {
    if (!attached || !statics) return undefined;
    const text = attached.b?.text() ?? statics.b ?? attached.a?.text() ?? statics.a;
    return text == null ? null : firstLineOf(text);
  }, [attached, statics]);
  useEffect(() => {
    if (firstLine === undefined) return;
    let alive = true;
    void languageFor(path, firstLine).then((l) => alive && setLang(() => l ?? NO_LANGUAGE));
    return () => {
      alive = false;
    };
  }, [path, firstLine]);

  const updateChunkInfo = useCallback((docChanged = false) => {
    const v = viewsRef.current?.b;
    if (!v) return;
    const chunks = getChunks(v.state)?.chunks ?? [];
    const head = v.state.selection.main.head;
    const current = chunks.findIndex((c) => c.fromB <= head && head <= Math.max(c.fromB, c.endB));
    const { moves, whitespaceOnly } = getDiffInsights(chunks);
    setChunkInfo((p) =>
      !docChanged &&
      p.count === chunks.length &&
      p.current === current &&
      p.moves === moves.length &&
      p.whitespaceOnly === whitespaceOnly
        ? p
        : { count: chunks.length, current, moves: moves.length, whitespaceOnly },
    );
  }, []);

  // A HEAD ↔ working file diff of a tracked change: blocks can be left out of the commit.
  const includable =
    useVcs((s) => {
      const fs = s.status.find((f) => stripSlash(f.path) === path);
      return !!fs && groupOf(fs) === "changes" && effectiveKind(fs) === "modified";
    }) &&
    left.type === "rev" &&
    left.rev === "HEAD" &&
    !left.path &&
    isWorktree(right);
  const editableA = !binary && (attached?.a ? !attached.a.readOnly : isEditableText(left));
  const editableB = !binary && (attached?.b ? !attached.b.readOnly : isEditableText(right));
  const ready = !!attached && !!statics && lang !== null && binary !== null;

  // Soft wraps follow the editor's (Settings › Editor › General) unless toggled in the viewer settings.
  const editorSoftWrap = useProject((s) => softWrapActive(s.settings?.editor?.softWrap, editorPrefs(s.settings), path));
  const softWrap = opts.softWrap ?? editorSoftWrap;
  const wrapSlot = useMemo(() => new Compartment(), []);
  const softWrapRef = useRef(softWrap);
  softWrapRef.current = softWrap;
  const toggleSoftWrapRef = useRef(() => {});
  toggleSoftWrapRef.current = () => setOpts({ softWrap: !softWrapRef.current });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready || binary) return;
    return registerSoftWrapSurface(host, {
      enabled: () => softWrapRef.current,
      toggle: () => toggleSoftWrapRef.current(),
    });
  }, [ready, binary]);

  // Read when the views are built; toggling it later goes through `setSync`.
  const syncScroll = useRef(opts.syncScroll);
  syncScroll.current = opts.syncScroll;

  // (Re)build the CodeMirror views.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !attached || !statics || lang === null) return;
    const typed = (s: Side) => edited[originOf(s, swapped)]?.toString();
    const textA = typed("a") ?? attached.a?.text() ?? statics.a ?? "";
    const textB = typed("b") ?? attached.b?.text() ?? statics.b ?? "";
    const prev = viewsRef.current;
    const scrollTop = prev
      ? prev.merge && !prev.panes
        ? (prev.merge.dom as HTMLElement).scrollTop
        : prev.b.scrollDOM.scrollTop
      : null;
    prev?.destroy();
    host.textContent = "";
    const listener = EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) updateChunkInfo(u.docChanged);
      if (u.selectionSet && u.view.hasFocus) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        const side = originOf(u.view === viewsRef.current?.a ? "a" : "b", swapped);
        rememberDiffCaret(inputKey.current, line.number - 1, head - line.from, side);
      }
    });
    const findWatch = (s: Side) => EditorView.updateListener.of((u) => findWatchers.current[s].forEach((fn) => fn(u)));
    /** Keeps what the user typed into an editable text side for the next rebuild (options, Swap Sides). */
    const keepEdits = (s: Side) =>
      isEditableText(s === "a" ? left : right)
        ? EditorView.updateListener.of((u) => {
            if (u.docChanged) edited[originOf(s, swapped)] = u.state.doc;
          })
        : [];
    const focusTracker = (side: "a" | "b") =>
      EditorView.domEventHandlers({
        focus: () => {
          focusedSide.current = side;
        },
        mousedown: (event, view) => {
          if (
            view.hasFocus ||
            event.button !== 0 ||
            event.detail !== 1 ||
            event.shiftKey ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey ||
            !view.contentDOM.contains(event.target as Node)
          )
            return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          // WebKit may scroll to the old DOM selection on focus. Place the caret first so
          // the default mouse handler measures the same position before and after focusing.
          view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
          view.focus();
          return false;
        },
      });
    const collapseUnchanged = opts.collapse ? { margin: 3, minSize: 6 } : undefined;
    const diffConfig = ideaDiffConfig(opts.ignore, opts.highlight);
    // One side alone has no words to compare: IDEA tints its lines, without fragments.
    const highlightChanges = opts.highlight === "words" && !single;
    const inclusion = includable ? inclusionGutter(path, textA) : [];
    const side = (att: DocumentAttachment | null, editable: boolean, notes?: "left" | "right"): Extension[] => [
      // The left pane of a side-by-side diff has its line numbers next to the divider, as in IDEA.
      viewerBase({ readOnly: !editable, findBar: true, lineNumbers: notes === "left" ? "after" : true }),
      collapseUnchanged ? collapsedDiffLines() : [],
      changedRanges,
      wrapSlot.of(softWrapRef.current ? EditorView.lineWrapping : []),
      // Esc closes the find bar before it collapses the selection (a found match); open popups go first.
      Prec.high(keymap.of([{ key: "Escape", run: () => findEscape.current() }])),
      lang,
      blameSlot(),
      att?.extension ?? [],
      // The file's open document: quick docs and ⌘/Ctrl-click navigation, as in its editor.
      att ? [diffSideExtensions(att.context()), documentTooltips] : [],
      editable ? [editableExtensions(), embeddedEditorExtensions(path)] : [],
      notes
        ? diffAnnotations(
            (data.annotations ?? []).filter((n) => n.side === notes),
            styles,
          )
        : [],
      notes ? contribs.map((c) => c.extensions?.({ side: notes, unified: viewMode !== "split" }) ?? []) : [],
    ];
    let views: Views;
    if (viewMode === "split") {
      let merge: MergeView | null = null;
      // Every split diff but a fitted block scrolls its panes themselves: a content-tall
      // pane would render its horizontal scrollbar at the content's end, out of reach
      // until the diff is scrolled there. The padded panes copy their scroll instead.
      const panes: DiffPanes | null = fit
        ? null
        : aligned
          ? new PaddedPanes(syncScroll.current)
          : new UnalignedPanes({
              sync: syncScroll.current,
              arrows:
                editableA || editableB
                  ? { toA: editableA, toB: editableB, apply: (i, source) => merge && applyChunk(merge, i, source) }
                  : undefined,
            });
      // IDEA's colouring: lines by chunk type, carried into the gutters, and typed word highlights.
      const colours = [
        changedLineGutters,
        highlightChanges ? diffWords : [],
        opts.highlight !== "none" ? movedCodeHighlights(highlightChanges) : [],
      ];
      const mv = new MergeView({
        a: {
          doc: textA,
          extensions: [
            side(attached.a, editableA, "left"),
            colours,
            // A fitted block keeps one stripe, on the right (as IDEA's shared scrollbar).
            fit ? [] : diffOverview("split"),
            panes?.extension ?? [],
            focusTracker("a"),
            findWatch("a"),
            keepEdits("a"),
            editableA ? hoverRevert((_v, i) => merge && applyChunk(merge, i, "b")) : [],
          ],
        },
        b: {
          doc: textB,
          extensions: [
            side(attached.b, editableB, "right"),
            colours,
            diffOverview("split"),
            panes?.extension ?? [],
            listener,
            focusTracker("b"),
            findWatch("b"),
            keepEdits("b"),
            inclusion,
            editableB ? hoverRevert((_v, i) => merge && applyChunk(merge, i, "a")) : [],
          ],
        },
        parent: host,
        // Unaligned panes draw their arrows on their own divider.
        revertControls: panes ? undefined : editableB ? "a-to-b" : editableA ? "b-to-a" : undefined,
        renderRevertControl:
          !panes && (editableA || editableB)
            ? arrowControls(() => merge, { toA: editableA, toB: editableB })
            : undefined,
        // Words are highlighted by type (`diffWords`), and gutters tinted instead of a change bar.
        highlightChanges: false,
        gutter: false,
        collapseUnchanged,
        diffConfig,
      });
      merge = mv;
      panes?.attach(mv);
      views = {
        a: mv.a,
        b: mv.b,
        merge: mv,
        panes,
        destroy: () => {
          panes?.destroy();
          mv.destroy();
        },
      };
      if (scrollTop != null)
        requestAnimationFrame(() => {
          // A fitted block scrolls on the merge view; the panes scroll themselves.
          if (!panes) (mv.dom as HTMLElement).scrollTop = scrollTop;
          else mv.b.scrollDOM.scrollTop = scrollTop;
        });
    } else {
      const view = new EditorView({
        doc: textB,
        parent: host,
        extensions: [
          side(attached.b, editableB, "right"),
          diffOverview("unified"),
          listener,
          focusTracker("b"),
          findWatch("b"),
          keepEdits("b"),
          inclusion,
          highlightChanges ? diffWords : [],
          unifiedMergeView({
            original: textA,
            highlightChanges,
            gutter: true,
            syntaxHighlightDeletions: true,
            mergeControls: editableB
              ? (type) => {
                  const btn = document.createElement("button");
                  btn.type = "button";
                  if (type === "accept") {
                    btn.hidden = true;
                    return btn;
                  }
                  btn.textContent = "Revert";
                  btn.title = "Revert this change";
                  onHunkButtonClick(btn, () => revertUnifiedChunk(view, view.posAtDOM(btn)));
                  return btn;
                }
              : false,
            collapseUnchanged,
            diffConfig,
          }),
        ],
      });
      views = { a: null, b: view, merge: null, panes: null, destroy: () => view.destroy() };
      if (scrollTop != null) requestAnimationFrame(() => (view.scrollDOM.scrollTop = scrollTop));
    }
    // The labels and the find bar above side-by-side panes start the right side where its pane
    // does, wherever the divider (dragged, see UnalignedPanes) and the window put it.
    const root = rootRef.current;
    if (views.a && root && typeof ResizeObserver !== "undefined") {
      const paneB = views.b.dom;
      const align = () =>
        root.style.setProperty(
          "--diff-b-start",
          `${paneB.getBoundingClientRect().left - root.getBoundingClientRect().left}px`,
        );
      const observer = new ResizeObserver(align);
      observer.observe(root);
      observer.observe(paneB);
      align();
      const destroyPanes = views.destroy;
      views.destroy = () => {
        observer.disconnect();
        root.style.removeProperty("--diff-b-start");
        destroyPanes();
      };
    }
    viewsRef.current = views;
    const built = viewerHost(views, dataRef.current, viewMode, () => focusedSide.current);
    const detach = contribs.map((c) => c.attach?.(built));
    const destroyViews = views.destroy;
    views.destroy = () => {
      detach.forEach((d) => d?.());
      destroyViews();
    };
    viewerRef.current = built;
    setViewer(built);
    setViewsGen((g) => g + 1);
    requestAnimationFrame(() => updateChunkInfo());
  }, [
    contribs,
    attached,
    statics,
    lang,
    viewMode,
    single,
    fit,
    aligned,
    opts.collapse,
    opts.ignore,
    opts.highlight,
    wrapSlot,
    editableA,
    editableB,
    updateChunkInfo,
    data.annotations,
    includable,
    path,
    left,
    right,
    swapped,
  ]);

  useEffect(() => {
    const views = viewsRef.current;
    if (!views) return;
    // Padded panes (an aligned split) re-insert MergeView's alignment spacers on their next measure,
    // after the wrap reflow, so a scroll snapshot drifts: anchor each pane to its visible line and
    // re-apply once the spacers land. Unaligned panes have no spacers; a fitted block has no scroller.
    const panes = views.panes instanceof PaddedPanes ? views.panes : null;
    const anchorFor = (view: EditorView) => {
      const top = view.scrollDOM.getBoundingClientRect().top;
      const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
      return EditorView.scrollIntoView(block.from, { y: "start", yMargin: block.top + view.documentTop - top });
    };
    const anchors = panes ? { a: views.a ? anchorFor(views.a) : null, b: anchorFor(views.b) } : null;
    // The re-anchored right pane leads the sync: the left pane's delayed reflow follows it rather than
    // being read as a user scroll that pulls the right pane back to where it was.
    if (anchors) panes?.leadScroll("b");
    for (const view of [views.a, views.b]) {
      if (!view) continue;
      const anchor = anchors ? (view === views.a ? anchors.a : anchors.b) : view.scrollSnapshot();
      view.dispatch({
        effects: [wrapSlot.reconfigure(softWrap ? EditorView.lineWrapping : []), ...(anchor ? [anchor] : [])],
      });
    }
    // MergeView inserts alignment spacers on its next measure, after the panes have reflowed.
    if (anchors) {
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (viewsRef.current !== views) return;
          panes?.leadScroll("b");
          if (views.a && anchors.a) views.a.dispatch({ effects: anchors.a });
          views.b.dispatch({ effects: anchors.b });
        });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [softWrap, wrapSlot, fit]);

  useEffect(() => viewsRef.current?.panes?.setSync(opts.syncScroll), [opts.syncScroll]);

  // The editor area focuses the tab's host (`[data-editor-focus]`), e.g. after F7 opened the next
  // file: hand that focus on to the diff, so its keymap and Jump to Source apply right away.
  useEffect(() => {
    // The blocks of an all-in-one diff share one tab: none takes its focus.
    const host = fit ? null : rootRef.current?.closest<HTMLElement>("[data-editor-focus]");
    const views = viewsRef.current;
    if (!host || !views) return;
    const forward = () => (focusedSide.current === "a" && views.a ? views.a : views.b).focus();
    const onFocus = (e: FocusEvent) => {
      if (e.target === host) forward();
    };
    host.addEventListener("focus", onFocus);
    if (document.activeElement === host) forward();
    return () => host.removeEventListener("focus", onFocus);
  }, [viewsGen, fit]);

  useEffect(
    () => () => {
      viewsRef.current?.destroy();
      viewsRef.current = null;
    },
    [],
  );

  // Reveal the requested line (or the first / last difference) once per request.
  const revealed = useRef<string | null>(null);
  const revealKey =
    data.line == null && !data.reveal ? null : `${data.line}:${data.col}:${data.lineSide}:${data.reveal}`;
  useEffect(() => {
    let v = viewsRef.current?.b;
    if (!v || revealKey === null || revealed.current === revealKey || !ready) return;
    revealed.current = revealKey;
    let at: number | undefined;
    if (data.line != null) {
      let line = data.line;
      if (data.lineSide === "left") {
        const found = viewerRef.current?.locate("left", line);
        if (found) [v, line] = [found.pane.view, found.line];
      }
      const target = v.state.doc.line(Math.min(v.state.doc.lines, Math.max(1, line + 1)));
      at = target.from + Math.min(data.col ?? 0, target.length);
    } else {
      const chunks = getChunks(v.state)?.chunks ?? [];
      at = (data.reveal === "last" ? chunks[chunks.length - 1] : chunks[0])?.fromB;
    }
    if (at === undefined) return;
    if (data.line != null) revealPos(v, at);
    else v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    // Keep keyboard navigation in the revealed pane after moving to another file.
    if (data.reveal || v === viewsRef.current?.a) v.focus();
    updateChunkInfo();
  }, [ready, statics, revealKey, data.line, data.col, data.lineSide, data.reveal, updateChunkInfo]);

  // IDEA: past the last (first) difference F7 (Shift+F7) first hints, then moves along the chain.
  const [navHint, setNavHint] = useState<string | null>(null);
  const pendingFile = useRef<0 | 1 | -1>(0);
  const navigation = useRef<object | null>(null);
  useEffect(
    () => () => {
      navigation.current = null;
    },
    [data],
  );
  const openNeighbour = useCallback(
    async (dir: 1 | -1) => {
      if (navigation.current) return;
      const request = {};
      navigation.current = request;
      try {
        const neighbour = await changedChainNeighbour(data, dir, opts.ignore);
        if (navigation.current !== request || !neighbour) return;
        if (onNeighbour) onNeighbour(neighbour);
        else await openDiff(neighbour, { preview: true });
      } finally {
        if (navigation.current === request) navigation.current = null;
      }
    },
    [data, opts.ignore, onNeighbour],
  );
  useEffect(() => {
    if (!navHint) return;
    const t = setTimeout(() => setNavHint(null), 2500);
    return () => clearTimeout(t);
  }, [navHint]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const views = viewsRef.current;
      if (!views) return;
      // Navigate in the focused pane of a side-by-side diff.
      const v = focusedSide.current === "a" && views.a ? views.a : views.b;
      const onA = v !== views.b;
      const chunks = getChunks(v.state)?.chunks ?? [];
      const head = v.state.selection.main.head;
      const start = (c: Chunk) => (onA ? c.fromA : c.fromB);
      const more = dir === 1 ? chunks.some((c) => start(c) > head) : chunks.some((c) => start(c) < head);
      if (!more) {
        const neighbour = chainNeighbour(data, dir);
        if (!neighbour) return;
        if (pendingFile.current === dir) {
          pendingFile.current = 0;
          setNavHint(null);
          void openNeighbour(dir);
        } else {
          pendingFile.current = dir;
          setNavHint(dir === 1 ? "Press again to go to the next file" : "Press again to go to the previous file");
        }
        return;
      }
      pendingFile.current = 0;
      setNavHint(null);
      (dir === 1 ? goToNextChunk : goToPreviousChunk)({
        state: v.state,
        dispatch: (tr) => {
          const selection = tr.selection ?? v.state.selection;
          // No scrollIntoView effect: it would set scrollTop in the same measure and cut off the
          // smooth scroll below, which centres the caret.
          v.dispatch({ selection, userEvent: "select.byChunk" });
          // CodeMirror draws the caret only in a focused editor, so a difference reached from
          // the toolbar, a menu or F7 pressed after those would move an invisible caret.
          v.focus();
          const scroller = views.merge && !views.panes ? views.merge.dom : v.scrollDOM;
          v.requestMeasure({
            key: step,
            read: () => {
              const documentTop = v.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
              const caret = v.coordsAtPos(v.state.selection.main.head);
              const lineTop = caret
                ? (caret.top + caret.bottom) / 2 - v.documentTop
                : v.lineBlockAt(v.state.selection.main.head).top;
              return documentTop + lineTop - scroller.clientHeight / 2;
            },
            write: (top) => {
              const options: ScrollToOptions = {
                top: Math.max(0, top),
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
              };
              if (views.panes) views.panes.scrollTo(onA ? "a" : "b", options);
              else scroller.scrollTo(options);
            },
          });
        },
      });
      if (v !== views.b) {
        // Mirror the caret into the right pane so the counter follows.
        const chunks = getChunks(v.state)?.chunks ?? [];
        const head = v.state.selection.main.head;
        const c = chunks.find((ch) => ch.fromA <= head && head <= Math.max(ch.fromA, ch.endA));
        if (c) views.b.dispatch({ selection: { anchor: Math.min(c.fromB, views.b.state.doc.length) } });
      }
      updateChunkInfo();
    },
    [updateChunkInfo, data, openNeighbour],
  );

  // A file-backed side is the source; for a diff of revisions (Git Log, Compare) the
  // working copy of the path is, while it exists. Probed once per diff.
  const fileSource = sideFile(left, path) ?? sideFile(right, path);
  const [onDisk, setOnDisk] = useState<string | null>(null);
  useEffect(() => {
    // A virtual path (a plugin's text diff) names no file on disk.
    if (fileSource || isVirtualUri(path)) return;
    let alive = true;
    void call(commands.fsProbe(path)).then(
      () => alive && setOnDisk(path),
      () => alive && setOnDisk(null),
    );
    return () => {
      alive = false;
    };
  }, [path, fileSource]);
  const worktreeSource = onDisk === path ? path : null;
  const source = fileSource ?? worktreeSource;

  const jumpToSource = useCallback(() => {
    const views = viewsRef.current;
    const fileA = sideFile(left, path);
    const fileB = sideFile(right, path);
    const onA = focusedSide.current === "a" && !!views?.a;
    const v = onA ? views!.a! : views?.b;
    const own = onA ? fileA : fileB;
    const file = own ?? fileB ?? fileA ?? worktreeSource;
    if (!file) return;
    const open = (line: number, col: number) => {
      onJumpToSource?.();
      void editorService().openFile(file, { selection: { line, col }, focus: true });
    };
    if (!v) return open(0, 0);
    const head = v.state.selection.main.head;
    const at = v.state.doc.lineAt(head);
    if (own) return open(at.number - 1, head - at.from);
    // The pane shows another version of the file: follow the diff to the line there.
    const from = v.state.doc;
    const known = file === fileB ? views?.b.state.doc : file === fileA ? views?.a?.state.doc : undefined;
    void (known ? Promise.resolve(known.toString()) : readWorkingText(file)).then((text) => {
      if (text === null) return open(at.number - 1, head - at.from);
      const to = Text.of(text.split(/\r?\n/));
      const line = mapLine(Chunk.build(from, to), at.number - 1, from, to);
      open(line, to.line(line + 1).text === at.text ? head - at.from : 0);
    });
  }, [left, right, path, worktreeSource, onJumpToSource]);

  const currentChunk = (): { chunk: Chunk; index: number } | undefined => {
    const v = viewsRef.current?.b;
    if (!v) return undefined;
    const chunks = getChunks(v.state)?.chunks ?? [];
    const head = v.state.selection.main.head;
    const index = Math.max(
      0,
      chunks.findIndex((c) => c.fromB <= head && head <= Math.max(c.fromB, c.endB)),
    );
    const chunk = chunks[index];
    return chunk ? { chunk, index } : undefined;
  };

  const revertChunk = () => {
    const views = viewsRef.current;
    const cur = currentChunk();
    if (!views || !cur) return;
    if (views.merge) applyChunk(views.merge, cur.index, "a");
    else revertUnifiedChunk(views.b, cur.chunk.fromB);
  };

  const stageChunk = async () => {
    const views = viewsRef.current;
    const cur = currentChunk();
    if (!views || !cur) return;
    setBusy(true);
    try {
      const aDoc = views.a?.state.doc ?? Text.of((attached?.a?.text() ?? statics?.a ?? "").split("\n"));
      const lines = chunkLines(cur.chunk, aDoc, views.b.state.doc);
      await saveAll();
      const [indexText, disk] = await Promise.all([call(commands.vcsFileAt(path, ":0")), readWorkingText(path)]);
      const hunks = await commands.vcsDiffHunks(indexText ?? "", disk ?? "");
      const leftIsIndex = isIndex(left);
      const indices = hunksOverlapping(hunks, {
        fromA: leftIsIndex ? lines.fromA : -1,
        toA: leftIsIndex ? lines.toA : -1,
        fromB: lines.fromB,
        toB: lines.toB,
      });
      if (!indices.length) {
        logConsole("info", "Nothing to stage for this change");
        return;
      }
      await runOp(tx`Stage hunk of ${path}`, () => call(commands.vcsStageHunks(path, indices)));
      await refreshNow();
    } finally {
      setBusy(false);
    }
  };

  // Find (⌘F / ⌘R / ⌘G): the editor's find bar over the focused side.
  const [find, setFind] = useState<{ side: Side; replace: boolean; seq: number } | null>(null);
  const findWatchers = useRef<Record<Side, Set<ViewUpdateFn>>>({ a: new Set(), b: new Set() });
  const findEscape = useRef<() => boolean>(() => false);
  /** The side the bar searches (the last one, once closed: closing clears its highlights). */
  const findSide = useRef<Side>("b");
  const findOpen = useRef(false);
  /** The find bar's Search In Changes, for this diff (as IDEA keeps it in the diff's context). */
  const searchInChanges = useRef(false);
  const findId = useId();
  const viewOf = (s: Side) => (s === "a" && viewsRef.current?.a) || viewsRef.current?.b || null;
  const findTarget = useMemo<FindTarget>(() => {
    const sideOf = (): Side => (findSide.current === "a" && viewsRef.current?.a ? "a" : "b");
    return {
      id: `diff:${findId}`,
      view: () => (sideOf() === "a" ? viewsRef.current?.a : viewsRef.current?.b) ?? null,
      watch(fn) {
        const set = findWatchers.current[sideOf()];
        set.add(fn);
        return () => void set.delete(fn);
      },
      isOpen: () => findOpen.current,
      inChanges: {
        get: () => searchInChanges.current,
        set: (on) => void (searchInChanges.current = on),
      },
    };
  }, [findId]);
  const editableSide = (s: Side) => (s === "a" ? editableA : editableB);

  const openFind = (replace: boolean) => {
    const views = viewsRef.current;
    if (!views) return;
    const s: Side = focusedSide.current === "a" && views.a ? "a" : "b";
    if (findOpen.current && findSide.current !== s)
      viewOf(findSide.current)?.dispatch({ effects: setFindOpen.of(false) });
    findSide.current = s;
    findOpen.current = true;
    const withReplace = replace && editableSide(s);
    seedFind(findTarget, withReplace);
    setFind((f) => ({ side: s, replace: withReplace, seq: (f?.seq ?? 0) + 1 }));
  };
  const closeFind = () => {
    findOpen.current = false;
    setFind(null);
    viewOf(findSide.current)?.focus();
  };
  findEscape.current = () => {
    if (!findOpen.current) return false;
    closeFind();
    return true;
  };
  /** Select Opposite Diff Pane (⌃⇧⇥): the other side keeps its own caret, as in IDEA. */
  const focusOpposite = () => {
    const views = viewsRef.current;
    if (!views?.a) return false;
    (focusedSide.current === "a" ? views.b : views.a).focus();
    return true;
  };
  const close = () => {
    if (!onClose) return false;
    onClose();
    return true;
  };
  /** Show Diff in External Tool: the panes' text, or a saved file where a side is one. */
  const externalDiff = useWorkflowSettings((s) => s.externalDiff);
  const canExternal = externalDiff.enabled && !!externalDiff.path && !binary;
  const showInExternalTool = () => {
    const views = viewsRef.current;
    if (!views || !canExternal) return false;
    const remote = isRemoteWindow();
    const sideOf = async (s: Side) => {
      const side = s === "a" ? left : right;
      const att = s === "a" ? attached?.a : attached?.b;
      const file = sideFile(side, path);
      const name = baseName((side.type === "rev" && side.path) || file || path) || "content";
      if (file && att && !remote) {
        await att.save();
        return { path: file, text: null, name };
      }
      const doc = s === "b" ? views.b.state.doc : (views.a?.state.doc ?? getOriginalDoc(views.b.state));
      return { path: null, text: doc.toString(), name };
    };
    void Promise.all([sideOf("a"), sideOf("b")])
      .then(([a, b]) => call(commands.diffExternalTool(a, b, diffTitle(data))))
      .catch((e) =>
        notifications().notify({
          group: "vcs",
          level: "error",
          title: "Cannot show diff in external tool",
          body: errorMessage(e),
        }),
      );
    return true;
  };
  /** Swap Sides: for diffs whose two sides the user picked (Compare Files, Clipboard, blank diff). */
  const canSwap = !!input_.swappable && !single;
  const swapSides = () => {
    if (!canSwap) return false;
    setSwappedFor(swapped ? null : input_);
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (isStrokeOf(e, "find.inFile")) openFind(false);
    else if (isStrokeOf(e, "find.replaceInFile")) openFind(true);
    else if (isStrokeOf(e, "find.next") || isStrokeOf(e, "find.previous")) {
      if (!findOpen.current) findSide.current = focusedSide.current;
      if (!searchAgain(findTarget, isStrokeOf(e, "find.next"))) openFind(false);
    } else if (e.key === "Escape" && findOpen.current) closeFind();
    // Esc that nothing in the diff took (find bar, selection, completion) closes its tab, as in IDEA.
    else if (!plainEscape(e) || isPopupOpen() || !close()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** ⌃⌘→ / ⌃⌘←: the change at the caret applied toward the other, editable side. */
  const applyChange = (source: "a" | "b") => {
    const views = viewsRef.current;
    const merge = views?.merge;
    if (!merge || !views.a || !(source === "a" ? editableB : editableA)) return false;
    const side = focusedSide.current;
    const view = side === "a" ? views.a : views.b;
    const index = chunkAt(merge.chunks, side, view.state.selection.main.head, view.state.doc.length);
    if (index < 0) return false;
    applyChunk(merge, index, source);
    return true;
  };
  const file = (dir: 1 | -1) => {
    void openNeighbour(dir);
  };
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  /** The viewer settings menu, under the toolbar's gear (`from`) or its start. */
  const showSettings = (from?: HTMLElement) => {
    const r = (from ?? toolbarRef.current)?.getBoundingClientRect();
    showContextMenu({ x: r ? r.left + (from ? 0 : 8) : 120, y: r ? r.bottom : 120 }, [
      { kind: "header", label: "Viewer" },
      {
        id: "split",
        label: "Side-by-side Viewer",
        checked: viewMode === "split",
        disabled: single,
        run: () => setOpts({ mode: "split" }),
      },
      {
        id: "unified",
        label: "Unified Viewer",
        checked: viewMode === "unified",
        disabled: single,
        run: () => setOpts({ mode: "unified" }),
      },
      { kind: "separator" },
      {
        id: "ignore",
        label: "Ignore Whitespace",
        submenu: IGNORE_OPTIONS.map((o) => ({
          id: o.value,
          label: o.label,
          checked: opts.ignore === o.value,
          run: () => setOpts({ ignore: o.value }),
        })),
      },
      {
        id: "highlight",
        label: "Highlighting",
        submenu: HIGHLIGHT_OPTIONS.map((o) => ({
          id: o.value,
          label: o.label,
          checked: opts.highlight === o.value,
          run: () => setOpts({ highlight: o.value }),
        })),
      },
      { kind: "separator" },
      {
        id: "collapse",
        label: "Collapse Unchanged Fragments",
        checked: opts.collapse,
        run: () => setOpts({ collapse: !opts.collapse }),
      },
      {
        id: "softWrap",
        label: "Use Soft Wraps",
        checked: softWrap,
        run: () => setOpts({ softWrap: !softWrap }),
      },
      {
        id: "sync",
        label: "Synchronize Scrolling",
        checked: opts.syncScroll,
        disabled: viewMode !== "split",
        run: () => setOpts({ syncScroll: !opts.syncScroll }),
      },
      {
        id: "align",
        label: "Align Changes",
        checked: aligned,
        disabled: viewMode !== "split" || fit,
        run: () => setOpts({ alignChanges: !opts.alignChanges }),
      },
      // A tab of one file of a change: show every file of it in one scrollable tab instead.
      ...(input_.chain && input_.chain.length > 1 && !input_.embedded && onClose
        ? [
            { kind: "separator" } as const,
            {
              id: "allInOne",
              label: "Show All Files in One Diff View",
              checked: false,
              run: () => {
                setAllInOneDiff(true);
                void openDiff(input_).then(() => onClose());
              },
            },
          ]
        : []),
      ...contribs.flatMap((c) => {
        const items = c.settingsItems?.() ?? [];
        return items.length ? [{ kind: "separator" } as const, ...items] : [];
      }),
    ]);
  };
  /** Annotate with Git Blame for a pane, by that side's own revision. */
  const blameItems = (pane: DiffViewerPane) => {
    const target = diffBlameTarget(pane.side === "left" ? left : right, path, !!getContext().vcsAvailable);
    if (!target) return [];
    const view = pane.view;
    const text = target.revision ? view.state.doc.toString() : undefined;
    return [
      {
        label: annotationsShown(view) ? "Close Annotations" : "Annotate with Git Blame",
        run: () => void toggleAnnotations(view, target.path, text, target.revision),
      },
    ];
  };
  /**
   * The panes' right-click menu: the contributions' items for the clicked line and Git annotations
   * (none: the default menu). The divider between the panes acts on the pane focused last.
   */
  const onContextMenu = (e: MouseEvent) => {
    const viewer = viewerRef.current;
    if (!viewer || e.defaultPrevented) return;
    const hit = viewer.panes().find((p) => p.view.dom.contains(e.target as Node | null));
    const pane = hit ?? viewer.focusedPane();
    const line = hit
      ? hit.view.state.doc.lineAt(hit.view.posAtCoords({ x: e.clientX, y: e.clientY }, false)).number - 1
      : -1;
    const groups = [
      ...(hit ? contribs.map((c) => c.contextMenuItems?.({ side: hit.side, line }) ?? []) : []),
      blameItems(pane),
    ].filter((g) => g.length);
    if (!groups.length) return;
    e.preventDefault();
    showContextMenu(
      e,
      groups.flatMap((g, i) => (i ? [{ kind: "separator" } as const, ...g] : g)),
    );
  };
  const viewerOf = () => viewerRef.current;
  const nav = useRef<DiffNavigator>({
    next: () => step(1),
    prev: () => step(-1),
    jumpToSource,
    applyChange,
    file,
    showSettings,
    focusOpposite,
    close,
    swapSides,
    showInExternalTool,
    viewer: viewerOf,
  });
  useLayoutEffect(() => {
    // Keep the registered navigator's identity while refreshing its handlers. Before paint, so a
    // shortcut pressed as the toolbar updates (Jump to Source once the working copy is found) runs
    // the handlers that toolbar shows.
    Object.assign(nav.current, {
      next: () => step(1),
      prev: () => step(-1),
      jumpToSource,
      applyChange,
      file,
      showSettings,
      focusOpposite,
      close,
      swapSides,
      showInExternalTool,
      viewer: viewerOf,
    });
  });

  useEffect(
    () => () => {
      if (focusedDiffNavigator() === nav.current) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
    [],
  );

  const textA = editedText("a") ?? attached?.a?.text() ?? statics?.a ?? "";
  const textB = editedText("b") ?? attached?.b?.text() ?? statics?.b ?? "";
  const eolA = attached?.a?.lineEnding() ?? detectLineEnding(textA);
  const eolB = attached?.b?.lineEnding() ?? detectLineEnding(textB);
  const rawA = attached?.a ? liveSideText(textA, eolA) : textA;
  const rawB = attached?.b ? liveSideText(textB, eolB) : textB;
  const badgeA = lineEndingBadge(rawA);
  const badgeB = lineEndingBadge(rawB);
  const sameText = rawA.replace(/\r\n?/g, "\n") === rawB.replace(/\r\n?/g, "\n");
  const eolOnly = ready && !binary && rawA !== rawB && sameText;
  const eolDiffers = ready && !binary && (badgeA !== badgeB || eolOnly);
  // Texts typed into a blank diff aren't files: no "identical" notice for them.
  const identical = ready && chunkInfo.count === 0 && rawA === rawB && !isEditableText(left) && !isEditableText(right);
  // Equal texts with different git modes: the change git records (chmod).
  const modeChange =
    identical && modes !== null && modes.a !== null && modes.b !== null && modes.a !== modes.b
      ? { from: modes.a, to: modes.b }
      : null;
  // Staging applies to local changes against HEAD / the index only.
  const canStage = editableB && isWorktree(right) && left.type === "rev" && !!useVcs.getState().root;
  const hasSource = !!source;

  const paneTitle = (s: DiffSide): { label: string; detail?: string } => {
    if (s.type === "worktree" || s.type === "text") return { label: sideLabel(s), detail: s.labelDetail };
    if (s.type !== "rev") return { label: sideLabel(s) };
    const file = s.path ?? path;
    const root = repoOf(file);
    const commit = !s.label && s.rev === "HEAD" && root ? heads[root]?.headCommit : null;
    return {
      label: commit ? commit.slice(0, 8) : sideLabel(s),
      detail: root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file,
    };
  };
  const titleA = paneTitle(left);
  const titleB = paneTitle(right);
  const captionA = [titleA.label, titleA.detail].filter(Boolean).join(" ");
  const captionB = [titleB.label, titleB.detail].filter(Boolean).join(" ");
  const sourceLabels = "labelDetail" in left || "labelDetail" in right;
  const labels = clsx(styles.labels, sourceLabels && styles.sourceLabels);

  return (
    <div
      ref={rootRef}
      className={clsx(styles.root, fit && styles.fit)}
      onKeyDown={onKeyDown}
      onFocusCapture={() => {
        setFocusedDiffNavigator(nav.current);
        setContext("diffEditorFocus", true);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedDiffNavigator() === nav.current) {
          setFocusedDiffNavigator(null);
          setContext("diffEditorFocus", false);
        }
      }}
    >
      <div ref={toolbarRef} className={styles.toolbar} role="toolbar" aria-label={tx("Diff")} hidden={fit}>
        <IconButton
          icon="arrow-up"
          title="Previous Difference"
          shortcut={shortcutLabel("diff.prevDifference")}
          size="small"
          onClick={() => step(-1)}
        />
        <IconButton
          icon="arrow-down"
          title="Next Difference"
          shortcut={shortcutLabel("diff.nextDifference")}
          size="small"
          onClick={() => step(1)}
        />
        {data.chain && (
          <>
            <IconButton
              icon="arrow-left"
              title="Compare Previous File"
              shortcut={shortcutLabel("diff.prevFile")}
              size="small"
              disabled={!chainNeighbour(data, -1)}
              onClick={() => file(-1)}
            />
            <IconButton
              icon="arrow-right"
              title="Compare Next File"
              shortcut={shortcutLabel("diff.nextFile")}
              size="small"
              disabled={!chainNeighbour(data, 1)}
              onClick={() => file(1)}
            />
          </>
        )}
        {hasSource && (
          <IconButton
            icon="edit"
            title="Jump to Source"
            shortcut={shortcutLabel("diff.jumpToSource")}
            size="small"
            onClick={jumpToSource}
          />
        )}
        <span className={styles.sep} />
        {canSwap && <IconButton icon="swap-panels" title="Swap Sides" size="small" onClick={() => void swapSides()} />}
        <IconButton
          icon="diff-side-by-side"
          className={styles.inlineOption}
          title="Side-by-side Viewer"
          size="small"
          pressed={viewMode === "split"}
          disabled={single}
          onClick={() => setOpts({ mode: "split" })}
        />
        <IconButton
          icon="diff-unified"
          className={styles.inlineOption}
          title="Unified Viewer"
          size="small"
          pressed={viewMode === "unified"}
          disabled={single}
          onClick={() => setOpts({ mode: "unified" })}
        />
        <span className={styles.sep} />
        <Select<IgnorePolicy>
          className={styles.select}
          value={opts.ignore}
          options={IGNORE_OPTIONS}
          onChange={(ignore) => setOpts({ ignore })}
          aria-label="Ignore whitespace"
        />
        <Select<HighlightPolicy>
          className={styles.select}
          value={opts.highlight}
          options={HIGHLIGHT_OPTIONS}
          onChange={(highlight) => setOpts({ highlight })}
          aria-label="Highlighting"
        />
        <IconButton
          icon="collapse-all"
          className={styles.inlineOption}
          title="Collapse Unchanged Fragments"
          size="small"
          pressed={opts.collapse}
          onClick={() => setOpts({ collapse: !opts.collapse })}
        />
        {viewMode === "split" && (
          <IconButton
            icon="lock"
            className={styles.inlineOption}
            title="Synchronize Scrolling"
            size="small"
            pressed={opts.syncScroll}
            onClick={() => setOpts({ syncScroll: !opts.syncScroll })}
          />
        )}
        {editableB && (
          <>
            <span className={styles.sep} />
            <IconButton
              icon="revert"
              title="Revert Change"
              size="small"
              disabled={!chunkInfo.count}
              onClick={revertChunk}
            />
            {canStage && (
              <IconButton
                icon="plus"
                title="Stage Change (git add hunk)"
                size="small"
                disabled={!chunkInfo.count || busy}
                onClick={() => void stageChunk()}
              />
            )}
          </>
        )}
        <span className={styles.sep} />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reload()} />
        <div className={styles.statusTools}>
          <span className={styles.count}>
            {binary && tx("Binary content")}
            {!ready || binary
              ? ""
              : chunkInfo.count === 0
                ? identical
                  ? modeChange
                    ? tx`File mode changed: ${modeChange.from} → ${modeChange.to}`
                    : tx("Contents are identical")
                  : eolOnly
                    ? tx("Contents differ only in line separators")
                    : chunkInfo.whitespaceOnly
                      ? tx("Whitespace-only changes")
                      : tx("No differences")
                : chunkInfo.current >= 0
                  ? tx`${chunkInfo.current + 1} of ${chunkInfo.count} differences`
                  : chunkInfo.count === 1
                    ? tx`${chunkInfo.count} difference`
                    : tx`${chunkInfo.count} differences`}
            {ready && !binary && chunkInfo.count > 0 && chunkInfo.whitespaceOnly && tx(" · Whitespace-only changes")}
            {ready &&
              !binary &&
              chunkInfo.moves > 0 &&
              (chunkInfo.moves === 1 ? tx(" · 1 moved block") : tx` · ${chunkInfo.moves} moved blocks`)}
          </span>
          {contribs.map((c, i) => c.Toolbar && <c.Toolbar key={i} host={viewer} />)}
          {toolbarActions}
          {canExternal && (
            <IconButton
              icon="external-tools"
              title="Show Diff in External Tool"
              size="small"
              onClick={() => void showInExternalTool()}
            />
          )}
          {getAction("vcs.showDiffInNewWindow") && auxiliaryWindow()?.kind !== "diff" && (
            <IconButton
              icon="external-link"
              title="Show Diff in New Window"
              size="small"
              onClick={() => void executeAction("vcs.showDiffInNewWindow", data)}
            />
          )}
          {auxiliaryWindow()?.kind === "diff" && getAction("vcs.showDiffInEditorTab") && (
            <IconButton
              icon="editor-only"
              title="Show Diff in Editor Tab"
              size="small"
              onClick={() => void executeAction("vcs.showDiffInEditorTab")}
            />
          )}
          <IconButton
            icon="settings"
            title="Settings"
            shortcut={shortcutLabel("diff.showSettings")}
            size="small"
            aria-haspopup="menu"
            onClick={(e) => showSettings(e.currentTarget)}
          />
        </div>
      </div>
      {viewMode === "split" ? (
        <div className={labels}>
          <span className={styles.label} title={captionA}>
            <span className={styles.labelText}>{titleA.label}</span>
            {titleA.detail && <span className={styles.labelFile}>{titleA.detail}</span>}
            {eolDiffers && eolA && <span className={styles.badge}>{badgeA}</span>}
            {editableA && (
              <span className={styles.badge}>
                <T>editable</T>
              </span>
            )}
          </span>
          <span className={styles.label} title={captionB}>
            <span className={styles.labelText}>{titleB.label}</span>
            {titleB.detail && <span className={styles.labelFile}>{titleB.detail}</span>}
            {eolDiffers && eolB && <span className={styles.badge}>{badgeB}</span>}
            {editableB && (
              <span className={styles.badge}>{left.type === "rev" ? tx("working copy") : tx("editable")}</span>
            )}
          </span>
        </div>
      ) : (
        <div className={labels}>
          <span className={styles.label} title={sourceLabels ? `${captionA} → ${captionB}` : undefined}>
            <span className={styles.labelText}>{sideLabel(left)}</span>
            {sourceLabels && titleA.detail && <span className={styles.labelFile}>{titleA.detail}</span>}
            {eolDiffers && eolA && <span className={styles.badge}>{badgeA}</span>} →
            <span className={styles.labelText}>{sideLabel(right)}</span>
            {sourceLabels && titleB.detail && <span className={styles.labelFile}>{titleB.detail}</span>}
            {eolDiffers && eolB && <span className={styles.badge}>{badgeB}</span>}
          </span>
        </div>
      )}
      {find && ready && (
        <div
          className={clsx(
            styles.findRow,
            viewMode === "split" && styles.findRowSplit,
            viewMode === "split" && find.side === "b" && styles.findRowRight,
          )}
        >
          <FindPanel
            target={findTarget}
            version={`${viewsGen}:${find.side}`}
            replace={find.replace}
            seq={find.seq}
            onReplaceShown={editableSide(find.side) ? (replace) => setFind((f) => f && { ...f, replace }) : undefined}
            onClose={closeFind}
          />
        </div>
      )}
      {binary ? (
        <div className={styles.message}>
          <T>Binary files cannot be shown as text</T>
        </div>
      ) : error ? (
        <div className={styles.message}>{error}</div>
      ) : !ready ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div
        ref={hostRef}
        className={clsx(
          styles.host,
          opts.highlight === "none" && styles.noHighlight,
          viewMode === "split" && !fit && styles.paneScroll,
        )}
        hidden={!!binary || !!error || !ready}
        aria-label={diffTitle(data)}
        role="region"
        onContextMenu={onContextMenu}
      />
      {navHint && (
        <div className={styles.navHint} role="status">
          {tx(navHint)}
        </div>
      )}
    </div>
  );
}
