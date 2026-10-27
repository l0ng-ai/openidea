/** Diff viewer editor tab (side-by-side / unified) built on @codemirror/merge. */
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { EditorView, keymap } from "@codemirror/view";
import { Text, type Extension } from "@codemirror/state";
import { history, historyKeymap } from "@codemirror/commands";
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView,
  type Chunk,
} from "@codemirror/merge";
import { attachDocument, embeddedEditorExtensions, type DocumentAttachment } from "@/editor/api";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { IconButton, Select, Spinner } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { languageFor, viewerBase } from "./cm";
import { applyChunk, arrowControls, hoverRevert } from "./diffControls";
import {
  HIGHLIGHT_OPTIONS,
  IGNORE_OPTIONS,
  loadDiffOptions,
  saveDiffOptions,
  whitespaceDiff,
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
  const focusedSide = useRef<"a" | "b">("b");
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
  const includable = useVcs((s) => {
    const fs = s.status.find((f) => stripSlash(f.path) === path);
    return !!fs && groupOf(fs) === "changes" && effectiveKind(fs) === "modified";
  }) && left.type === "rev" && left.rev === "HEAD" && !left.path && isWorktree(right);
  const editableA = !!attached?.a && !attached.a.readOnly;
  const editableB = !!attached?.b && !attached.b.readOnly;
  const ready = !!attached && !!statics && lang !== null;

  // (Re)build the CodeMirror views.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !attached || !statics || lang === null) return;
    const textA = attached.a?.text() ?? statics.a ?? "";
    const textB = attached.b?.text() ?? statics.b ?? "";
    const scrollTop = viewsRef.current
      ? viewsRef.current.merge
        ? (viewsRef.current.merge.dom as HTMLElement).scrollTop
        : viewsRef.current.b.scrollDOM.scrollTop
      : null;
    viewsRef.current?.destroy();
    host.textContent = "";
    const listener = EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) updateChunkInfo();
    });
    const focusTracker = (side: "a" | "b") =>
      EditorView.domEventHandlers({
        focus: () => {
          focusedSide.current = side;
        },
      });
    const collapseUnchanged = opts.collapse ? { margin: 3, minSize: 6 } : undefined;
    const override = whitespaceDiff(opts.ignore);
    const diffConfig = override ? { override } : undefined;
    const highlightChanges = opts.highlight === "words";
    const inclusion = includable ? inclusionGutter(path, textA) : [];
    const side = (att: DocumentAttachment | null, editable: boolean, notes?: "left" | "right"): Extension[] => [
      viewerBase({ readOnly: !editable }),
      lang,
      att?.extension ?? [],
      editable ? [editableExtensions(), embeddedEditorExtensions(path)] : [],
      notes ? diffAnnotations((data.annotations ?? []).filter((n) => n.side === notes), styles) : [],
    ];
    let views: Views;
    if (opts.mode === "split") {
      let merge: MergeView | null = null;
      const mv = new MergeView({
        a: {
          doc: textA,
          extensions: [
            side(attached.a, editableA, "left"),
            focusTracker("a"),
            editableA ? hoverRevert((_v, i) => merge && applyChunk(merge, i, "b")) : [],
          ],
        },
        b: {
          doc: textB,
          extensions: [
            side(attached.b, editableB, "right"),
            listener,
            focusTracker("b"),
            inclusion,
            editableB ? hoverRevert((_v, i) => merge && applyChunk(merge, i, "a")) : [],
          ],
        },
        parent: host,
        revertControls: editableB ? "a-to-b" : editableA ? "b-to-a" : undefined,
        renderRevertControl:
          editableA || editableB ? arrowControls(() => merge, { toA: editableA, toB: editableB }) : undefined,
        highlightChanges,
        gutter: true,
        collapseUnchanged,
        diffConfig,
      });
      merge = mv;
      views = { a: mv.a, b: mv.b, merge: mv, destroy: () => mv.destroy() };
      if (scrollTop != null) requestAnimationFrame(() => ((mv.dom as HTMLElement).scrollTop = scrollTop));
    } else {
      const view = new EditorView({
        doc: textB,
        parent: host,
        extensions: [
          side(attached.b, editableB, "right"),
          listener,
          focusTracker("b"),
          inclusion,
          unifiedMergeView({
            original: textA,
            highlightChanges,
            gutter: true,
            syntaxHighlightDeletions: true,
            mergeControls: editableB
              ? (type, action) => {
                  const btn = document.createElement("button");
                  if (type === "accept") {
                    btn.hidden = true;
                    return btn;
                  }
                  btn.textContent = "Revert";
                  btn.title = "Revert this change";
                  btn.onmousedown = action;
                  return btn;
                }
              : false,
            collapseUnchanged,
            diffConfig,
          }),
        ],
      });
      views = { a: null, b: view, merge: null, destroy: () => view.destroy() };
      if (scrollTop != null) requestAnimationFrame(() => (view.scrollDOM.scrollTop = scrollTop));
    }
    viewsRef.current = views;
    requestAnimationFrame(updateChunkInfo);
  }, [attached, statics, lang, opts.mode, opts.collapse, opts.ignore, opts.highlight, editableA, editableB, updateChunkInfo, data.annotations, includable, path]);

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

  const jumpToSource = useCallback(() => {
    const views = viewsRef.current;
    const fileA = sideFile(left, path);
    const fileB = sideFile(right, path);
    const useA = focusedSide.current === "a" && !!views?.a && !!fileA;
    const v = useA ? views!.a! : views?.b;
    const file = useA ? fileA : (fileB ?? fileA);
    if (!file) return;
    const head = v ? v.state.selection.main.head : 0;
    const line = v ? v.state.doc.lineAt(head) : null;
    void editorService().openFile(file, {
      selection: { line: line ? line.number - 1 : 0, col: line ? head - line.from : 0 },
      focus: true,
    });
  }, [left, right, path]);

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
    else rejectChunk(views.b, cur.chunk.fromB);
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

  const nav = useRef<DiffNavigator>({ next: () => step(1), prev: () => step(-1), jumpToSource });
  useEffect(() => {
    nav.current = { next: () => step(1), prev: () => step(-1), jumpToSource };
  }, [step, jumpToSource]);

  useEffect(
    () => () => {
      if (focusedDiffNavigator() === nav.current) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
    [],
  );

  const identical = ready && chunkInfo.count === 0 && (attached?.a?.text() ?? statics?.a) === (attached?.b?.text() ?? statics?.b);
  // Staging applies to local changes against HEAD / the index only.
  const canStage = editableB && isWorktree(right) && left.type === "rev" && !!useVcs.getState().root;
  const hasSource = !!sideFile(left, path) || !!sideFile(right, path);

  return (
    <div
      className={styles.root}
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
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Diff")}>
        <IconButton icon="arrow-up" title="Previous Difference" shortcut={shortcutLabel("diff.prevDifference")} size="small" onClick={() => step(-1)} />
        <IconButton icon="arrow-down" title="Next Difference" shortcut={shortcutLabel("diff.nextDifference")} size="small" onClick={() => step(1)} />
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
            <IconButton icon="revert" title="Revert Change" size="small" disabled={!chunkInfo.count} onClick={revertChunk} />
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
        {hasSource && (
          <IconButton icon="external-link" title="Jump to Source" shortcut={shortcutLabel("diff.jumpToSource")} size="small" onClick={jumpToSource} />
        )}
        <span className={styles.count}>
          {!ready
            ? ""
            : chunkInfo.count === 0
              ? identical
                ? "Contents are identical"
                : "No differences"
              : chunkInfo.current >= 0
                ? `${chunkInfo.current + 1} of ${chunkInfo.count} differences`
                : `${chunkInfo.count} difference${chunkInfo.count === 1 ? "" : "s"}`}
        </span>
      </div>
      {opts.mode === "split" ? (
        <div className={styles.labels}>
          <span className={styles.label} title={sideLabel(left)}>
            {sideLabel(left)}
            {editableA && <span className={styles.badge}>editable</span>}
          </span>
          <span className={styles.label} title={sideLabel(right)}>
            {sideLabel(right)}
            {editableB && <span className={styles.badge}>{left.type === "rev" ? "working copy" : "editable"}</span>}
          </span>
        </div>
      ) : (
        <div className={styles.labels}>
          <span className={styles.label}>
            {sideLabel(left)} → {sideLabel(right)}
          </span>
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
          opts.mode === "split" && !opts.syncScroll && styles.unsynced,
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
