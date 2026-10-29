/** Diff viewer editor tab (side-by-side / unified) built on @codemirror/merge. */
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, Text, type Extension } from "@codemirror/state";
import { history, historyKeymap } from "@codemirror/commands";
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView, Chunk } from "@codemirror/merge";
import { attachDocument, embeddedEditorExtensions, type DocumentAttachment } from "@/editor/api";
import { setFindOpen } from "@/editor/core/cm/find";
import { FindPanel, searchAgain, seedFind, type FindTarget } from "@/editor/core/view/FindBar";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, shortcutLabel, strokeOf } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { IconButton, Select, Spinner, T, showContextMenu } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { changedLineGutters, diffWords, languageFor, viewerBase } from "./cm";
import { applyChunk, arrowControls, chunkAt, hoverRevert, revertUnifiedChunk } from "./diffControls";
import {
  HIGHLIGHT_OPTIONS,
  IGNORE_OPTIONS,
  ideaDiffConfig,
  loadDiffOptions,
  saveDiffOptions,
  type DiffViewOptions,
  type HighlightPolicy,
  type IgnorePolicy,
} from "./diffOptions";
import {
  chainNeighbour,
  diffTitle,
  isIndex,
  isWorktree,
  loadSide,
  openDiff,
  sideFile,
  sideKey,
  sideLabel,
  type DiffData,
  type DiffSide,
} from "./diffInput";
import { diffAnnotations } from "./diffAnnotations";
import { UnalignedPanes } from "./diffScroll";
import { groupOf } from "./changes";
import { inclusionGutter } from "./hunkInclusion";
import { hunksOverlapping } from "./hunks";
import { effectiveKind, stripSlash } from "./model";
import { errorMessage, logConsole, readWorkingText, runOp, saveAll } from "./ops";
import { refreshNow, useVcs } from "./store";
import styles from "./DiffEditor.module.css";

/** Commands of the focused diff viewer (diff.* actions, vcs.nextChange / prevChange). */
export { focusedDiffNavigator, type DiffNavigator };

interface Views {
  /** The right / unified editor (chunks live here). */
  b: EditorView;
  a: EditorView | null;
  merge: MergeView | null;
  /** Unpadded side-by-side panes with synchronized scrolling (IDEA). */
  panes: UnalignedPanes | null;
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

type Side = "a" | "b";
type ViewUpdateFn = (u: { docChanged: boolean; selectionSet: boolean }) => void;

/** Whether `e` is one of the strokes bound to `actionId`. */
function isStrokeOf(e: KeyboardEvent, actionId: string): boolean {
  const stroke = strokeOf(e.nativeEvent);
  return !!stroke && bindingsFor(actionId).some((b) => normalizeBinding(b) === stroke);
}

export function DiffEditor({ input }: { input: EditorInput }) {
  const data = input.data as DiffData;
  const { path, left, right } = data;
  const [attached, setAttached] = useState<Attached | null>(null);
  /** Text of the sides that are not live documents. */
  const [statics, setStatics] = useState<{ a: string | null; b: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opts, setOptsState] = useState<DiffViewOptions>(loadDiffOptions);
  const [lang, setLang] = useState<Extension | null>(null);
  const [chunkInfo, setChunkInfo] = useState({ count: 0, current: -1 });
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<Views | null>(null);
  const staticsRef = useRef(statics);
  const focusedSide = useRef<Side>("b");
  /** Bumped when the views are rebuilt, so the find bar re-applies its query. */
  const [viewsGen, setViewsGen] = useState(0);
  const version = useVcs((s) => s.version);
  const leftKey = sideKey(left);
  const rightKey = sideKey(right);

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
      const [a, b] = await Promise.all([
        attached.a ? null : loadSide(path, left),
        attached.b ? null : loadSide(path, right),
      ]);
      const prev = staticsRef.current;
      if (!prev || prev.a !== a || prev.b !== b) {
        staticsRef.current = { a, b };
        setStatics({ a, b });
      }
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

  useEffect(() => {
    let alive = true;
    void languageFor(path).then((l) => alive && setLang(() => l ?? []));
    return () => {
      alive = false;
    };
  }, [path]);

  const updateChunkInfo = useCallback(() => {
    const v = viewsRef.current?.b;
    if (!v) return;
    const chunks = getChunks(v.state)?.chunks ?? [];
    const head = v.state.selection.main.head;
    const current = chunks.findIndex((c) => c.fromB <= head && head <= Math.max(c.fromB, c.endB));
    setChunkInfo((p) => (p.count === chunks.length && p.current === current ? p : { count: chunks.length, current }));
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
  const editableA = !!attached?.a && !attached.a.readOnly;
  const editableB = !!attached?.b && !attached.b.readOnly;
  const ready = !!attached && !!statics && lang !== null;

  // Read when the views are built; toggling it later goes through `setSync`.
  const syncScroll = useRef(opts.syncScroll);
  syncScroll.current = opts.syncScroll;

  // (Re)build the CodeMirror views.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !attached || !statics || lang === null) return;
    const textA = attached.a?.text() ?? statics.a ?? "";
    const textB = attached.b?.text() ?? statics.b ?? "";
    const prev = viewsRef.current;
    const scrollTop = prev
      ? prev.merge && !prev.panes
        ? (prev.merge.dom as HTMLElement).scrollTop
        : prev.b.scrollDOM.scrollTop
      : null;
    prev?.destroy();
    host.textContent = "";
    const listener = EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) updateChunkInfo();
    });
    const findWatch = (s: Side) => EditorView.updateListener.of((u) => findWatchers.current[s].forEach((fn) => fn(u)));
    const focusTracker = (side: "a" | "b") =>
      EditorView.domEventHandlers({
        focus: () => {
          focusedSide.current = side;
        },
      });
    const collapseUnchanged = opts.collapse ? { margin: 3, minSize: 6 } : undefined;
    const diffConfig = ideaDiffConfig(opts.ignore, opts.highlight);
    const highlightChanges = opts.highlight === "words";
    const inclusion = includable ? inclusionGutter(path, textA) : [];
    const side = (att: DocumentAttachment | null, editable: boolean, notes?: "left" | "right"): Extension[] => [
      viewerBase({ readOnly: !editable, findBar: true }),
      // Esc closes the find bar before it collapses the selection (a found match); open popups go first.
      Prec.high(keymap.of([{ key: "Escape", run: () => findEscape.current() }])),
      lang,
      att?.extension ?? [],
      editable ? [editableExtensions(), embeddedEditorExtensions(path)] : [],
      notes
        ? diffAnnotations(
            (data.annotations ?? []).filter((n) => n.side === notes),
            styles,
          )
        : [],
    ];
    let views: Views;
    if (opts.mode === "split") {
      let merge: MergeView | null = null;
      const panes = opts.alignChanges
        ? null
        : new UnalignedPanes({
            sync: syncScroll.current,
            arrows:
              editableA || editableB
                ? { toA: editableA, toB: editableB, apply: (i, source) => merge && applyChunk(merge, i, source) }
                : undefined,
          });
      // IDEA's colouring: lines by chunk type, carried into the gutters, and typed word highlights.
      const colours = [changedLineGutters, highlightChanges ? diffWords : []];
      const mv = new MergeView({
        a: {
          doc: textA,
          extensions: [
            side(attached.a, editableA, "left"),
            colours,
            panes?.extension ?? [],
            focusTracker("a"),
            findWatch("a"),
            editableA ? hoverRevert((_v, i) => merge && applyChunk(merge, i, "b")) : [],
          ],
        },
        b: {
          doc: textB,
          extensions: [
            side(attached.b, editableB, "right"),
            colours,
            panes?.extension ?? [],
            listener,
            focusTracker("b"),
            findWatch("b"),
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
          // The left pane of unpadded panes follows by itself.
          if (!panes) (mv.dom as HTMLElement).scrollTop = scrollTop;
          else mv.b.scrollDOM.scrollTop = scrollTop;
        });
    } else {
      const view = new EditorView({
        doc: textB,
        parent: host,
        extensions: [
          side(attached.b, editableB, "right"),
          listener,
          focusTracker("b"),
          findWatch("b"),
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
                  if (type === "accept") {
                    btn.hidden = true;
                    return btn;
                  }
                  btn.textContent = "Revert";
                  btn.title = "Revert this change";
                  btn.onmousedown = (event) => {
                    event.preventDefault();
                    revertUnifiedChunk(view, view.posAtDOM(btn));
                  };
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
    viewsRef.current = views;
    setViewsGen((g) => g + 1);
    requestAnimationFrame(updateChunkInfo);
  }, [
    attached,
    statics,
    lang,
    opts.mode,
    opts.alignChanges,
    opts.collapse,
    opts.ignore,
    opts.highlight,
    editableA,
    editableB,
    updateChunkInfo,
    data.annotations,
    includable,
    path,
  ]);

  useEffect(() => viewsRef.current?.panes?.setSync(opts.syncScroll), [opts.syncScroll]);

  useEffect(
    () => () => {
      viewsRef.current?.destroy();
      viewsRef.current = null;
    },
    [],
  );

  // Reveal the requested line (or the first / last difference) once.
  const revealed = useRef(false);
  useEffect(() => {
    const v = viewsRef.current?.b;
    if (!v || revealed.current || (data.line == null && !data.reveal) || !ready) return;
    revealed.current = true;
    let at: number | undefined;
    if (data.line != null) at = v.state.doc.line(Math.min(v.state.doc.lines, Math.max(1, data.line + 1))).from;
    else {
      const chunks = getChunks(v.state)?.chunks ?? [];
      at = (data.reveal === "last" ? chunks[chunks.length - 1] : chunks[0])?.fromB;
    }
    if (at === undefined) return;
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    updateChunkInfo();
  }, [ready, statics, data.line, data.reveal, updateChunkInfo]);

  // IDEA: past the last (first) difference F7 (Shift+F7) first hints, then moves along the chain.
  const [navHint, setNavHint] = useState<string | null>(null);
  const pendingFile = useRef<0 | 1 | -1>(0);
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
          void openDiff(neighbour, { preview: true });
        } else {
          pendingFile.current = dir;
          setNavHint(dir === 1 ? "Press again to go to the next file" : "Press again to go to the previous file");
        }
        return;
      }
      pendingFile.current = 0;
      setNavHint(null);
      (dir === 1 ? goToNextChunk : goToPreviousChunk)({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
      if (v !== views.b) {
        // Mirror the caret into the right pane so the counter follows.
        const chunks = getChunks(v.state)?.chunks ?? [];
        const head = v.state.selection.main.head;
        const c = chunks.find((ch) => ch.fromA <= head && head <= Math.max(ch.fromA, ch.endA));
        if (c) views.b.dispatch({ selection: { anchor: Math.min(c.fromB, views.b.state.doc.length) } });
      }
      updateChunkInfo();
    },
    [updateChunkInfo, data],
  );

  // A file-backed side is the source; for a diff of revisions (Git Log, Compare) the
  // working copy of the path is, while it exists. Probed once per diff.
  const fileSource = sideFile(left, path) ?? sideFile(right, path);
  const [onDisk, setOnDisk] = useState<string | null>(null);
  useEffect(() => {
    if (fileSource) return;
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
    const open = (line: number, col: number) =>
      void editorService().openFile(file, { selection: { line, col }, focus: true });
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
  }, [left, right, path, worktreeSource]);

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
      await runOp(`Stage hunk of ${path}`, () => call(commands.vcsStageHunks(path, indices)));
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
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (isStrokeOf(e, "find.inFile")) openFind(false);
    else if (isStrokeOf(e, "find.replaceInFile")) openFind(true);
    else if (isStrokeOf(e, "find.next") || isStrokeOf(e, "find.previous")) {
      if (!findOpen.current) findSide.current = focusedSide.current;
      if (!searchAgain(findTarget, isStrokeOf(e, "find.next"))) openFind(false);
    } else if (e.key === "Escape" && findOpen.current) closeFind();
    else return;
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
    const neighbour = chainNeighbour(data, dir);
    if (neighbour) void openDiff(neighbour, { preview: true });
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
        checked: opts.mode === "split",
        run: () => setOpts({ mode: "split" }),
      },
      {
        id: "unified",
        label: "Unified Viewer",
        checked: opts.mode === "unified",
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
        id: "sync",
        label: "Synchronize Scrolling",
        checked: opts.syncScroll,
        disabled: opts.mode !== "split",
        run: () => setOpts({ syncScroll: !opts.syncScroll }),
      },
      {
        id: "align",
        label: "Align Changes",
        checked: opts.alignChanges,
        disabled: opts.mode !== "split",
        run: () => setOpts({ alignChanges: !opts.alignChanges }),
      },
    ]);
  };
  const nav = useRef<DiffNavigator>({
    next: () => step(1),
    prev: () => step(-1),
    jumpToSource,
    applyChange,
    file,
    showSettings,
  });
  useEffect(() => {
    nav.current = { next: () => step(1), prev: () => step(-1), jumpToSource, applyChange, file, showSettings };
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

  const identical =
    ready && chunkInfo.count === 0 && (attached?.a?.text() ?? statics?.a) === (attached?.b?.text() ?? statics?.b);
  // Staging applies to local changes against HEAD / the index only.
  const canStage = editableB && isWorktree(right) && left.type === "rev" && !!useVcs.getState().root;
  const hasSource = !!source;

  return (
    <div
      className={styles.root}
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
      <div ref={toolbarRef} className={styles.toolbar} role="toolbar" aria-label={tx("Diff")}>
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
        <IconButton
          icon="split"
          title="Side-by-side Viewer"
          size="small"
          pressed={opts.mode === "split"}
          onClick={() => setOpts({ mode: "split" })}
        />
        <IconButton
          icon="list"
          title="Unified Viewer"
          size="small"
          pressed={opts.mode === "unified"}
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
          title="Collapse Unchanged Fragments"
          size="small"
          pressed={opts.collapse}
          onClick={() => setOpts({ collapse: !opts.collapse })}
        />
        {opts.mode === "split" && (
          <IconButton
            icon="lock"
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
        <span className={styles.count}>
          {!ready
            ? ""
            : chunkInfo.count === 0
              ? identical
                ? tx("Contents are identical")
                : tx("No differences")
              : chunkInfo.current >= 0
                ? tx`${chunkInfo.current + 1} of ${chunkInfo.count} differences`
                : chunkInfo.count === 1
                  ? tx`${chunkInfo.count} difference`
                  : tx`${chunkInfo.count} differences`}
        </span>
        <IconButton
          icon="settings"
          title="Settings"
          shortcut={shortcutLabel("diff.showSettings")}
          size="small"
          aria-haspopup="menu"
          onClick={(e) => showSettings(e.currentTarget)}
        />
      </div>
      {opts.mode === "split" ? (
        <div className={styles.labels}>
          <span className={styles.label} title={sideLabel(left)}>
            {sideLabel(left)}
            {editableA && (
              <span className={styles.badge}>
                <T>editable</T>
              </span>
            )}
          </span>
          <span className={styles.label} title={sideLabel(right)}>
            {sideLabel(right)}
            {editableB && (
              <span className={styles.badge}>{left.type === "rev" ? tx("working copy") : tx("editable")}</span>
            )}
          </span>
        </div>
      ) : (
        <div className={styles.labels}>
          <span className={styles.label}>
            {sideLabel(left)} → {sideLabel(right)}
          </span>
        </div>
      )}
      {find && ready && (
        <div
          className={clsx(
            styles.findRow,
            opts.mode === "split" && styles.findRowSplit,
            opts.mode === "split" && find.side === "b" && styles.findRowRight,
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
      {error ? (
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
          opts.mode === "split" && (opts.alignChanges ? !opts.syncScroll && styles.unsynced : styles.unaligned),
        )}
        hidden={!!error || !ready}
        aria-label={diffTitle(data)}
        role="region"
      />
      {navHint && (
        <div className={styles.navHint} role="status">
          {tx(navHint)}
        </div>
      )}
    </div>
  );
}
