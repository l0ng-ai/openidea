import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { useStore } from "zustand";
import type { StagedText } from "@/bindings";
import { attachDocument, type DocumentAttachment } from "@/editor/api";
import { executeAction, getAction } from "@/platform/actions";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { Button, IconButton } from "@/ui";
import { editorService, useEditorShown } from "@/workbench/contributions";
import type { DiffEditorProps } from "./DiffEditor";
import { requireDisplayedText, staleDiff, writeIndexChunk } from "./stagingDiffEdits";
import {
  chainNeighbour,
  hasGitlink,
  isIndex,
  openDiff,
  readDiffSide,
  sideKey,
  sideLabel,
  type DiffData,
  type DiffSide,
} from "./diffInput";
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { transferChunk } from "./diffOptions";
import { errorMessage, runOp } from "./ops";
import { refreshNow, statusOf, useVcs } from "./store";
import { stagingVersions } from "./stagingVersions";
import { initialDiffRanges, mapDiffRange, type StagingRange } from "./stagingRange";
import {
  currentStagedDiffPath,
  emptyStagedStatus,
  reloadStagedDocument,
  useEmbeddedStagedSave,
  useStagedDiffDocument,
  type StagedDocument,
} from "./stagedDocument";
import { stripSlash } from "./model";
import { diffDocument } from "./diffControls";
import {
  compareThreeTexts,
  ThreePaneDiff,
  type HunkControl,
  type PaneIndex,
  type ThreePaneChange,
  type ThreePanes,
} from "./ThreePaneDiff";
import styles from "./DiffEditor.module.css";

type Operation = "unstage" | "stage" | "revert";
const OPERATION_TITLE: Record<Operation, string> = {
  unstage: "Unstage Change",
  stage: "Stage Change (git add hunk)",
  revert: "Revert Change",
};

interface Snapshot {
  model: ReturnType<typeof compareThreeTexts>;
  index: StagedText | null;
  indexPath: string;
  head: DiffSide;
  local: DiffSide;
}

function useRangeSnapshot(range: StagingRange | undefined, full: Snapshot | null) {
  const [view, setView] = useState<{ range: StagingRange; source: Snapshot; snapshot: Snapshot | null } | null>(null);
  if (!range || !full) return full;
  if (view?.range === range && view.source === full) return view.snapshot;
  const docs = full.model.docs;
  const previous = view?.range === range ? view.snapshot?.model : null;
  const baseline = diffDocument(full.index?.text ?? null);
  const initial = previous ? null : initialDiffRanges(range, [docs[0], baseline, docs[2]], full.index?.version);
  const mapped = previous?.ranges
    ? ([
        mapDiffRange(previous.ranges[0], previous.docs[0], docs[0]),
        mapDiffRange(previous.ranges[1], previous.docs[1], docs[1]),
        mapDiffRange(previous.ranges[2], previous.docs[2], docs[2]),
      ] as const)
    : initial && ([initial[0], mapDiffRange(initial[1], baseline, docs[1]), initial[2]] as const);
  const ranges = mapped?.[0] && mapped[1] && mapped[2] ? ([mapped[0], mapped[1], mapped[2]] as const) : null;
  const snapshot = ranges ? { ...full, model: compareThreeTexts(full.model.texts, ranges) } : null;
  setView({ range, source: full, snapshot });
  return snapshot;
}

async function loadSnapshot(
  data: DiffData & { middle: DiffSide },
  document: DocumentAttachment | null,
): Promise<Snapshot> {
  const gitlink = hasGitlink(data);
  const status = !gitlink && statusOf(data.path);
  const { left: head, middle, right: local } = (status && stagingVersions(status)) || data;
  const indexPath = middle.type === "rev" ? (middle.path ?? data.path) : data.path;
  const [headText, index, localText] = await Promise.all([
    readDiffSide(data.path, head),
    !gitlink && isIndex(middle) ? call(commands.vcsStagedText(indexPath)) : null,
    local.type === "worktree" && document ? document.text() : readDiffSide(data.path, local),
  ]);
  const indexText = index?.text ?? (await readDiffSide(data.path, middle));
  const model = compareThreeTexts([headText, indexText, localText]);
  return { model, index, indexPath, head, local };
}

async function applyChange(
  path: string,
  displayed: Snapshot,
  change: ThreePaneChange,
  operation: Operation,
  localDocument: () => DocumentAttachment | null,
  indexDocument: StagedDocument | null,
) {
  const { index, indexPath, model } = displayed;
  if (!index) return;
  if (indexDocument && indexDocument.path !== stripSlash(indexPath)) throw staleDiff();
  const [, staged, working] = model.docs;
  const ranges = (source: PaneIndex, destination: PaneIndex) =>
    model.ranges && { source: model.ranges[source], destination: model.ranges[destination] };
  const doc = localDocument();
  if (operation === "revert") {
    if (!doc) throw staleDiff();
    const current = await call(commands.vcsStagedText(indexPath));
    if (current?.version !== index.version || doc !== localDocument()) throw staleDiff();
    if (doc.readOnly) throw new Error(tx("File is read-only"));
    if (indexDocument) requireDisplayedText(indexDocument.status.getState().text, staged);
    requireDisplayedText(doc.text(), working);
    doc.edit(transferChunk(change.chunk, "a", staged, working, ranges(1, 2)), "revert");
    return;
  }
  const source = operation === "unstage" ? 0 : 2;
  const textOnSource =
    source === 0
      ? await readDiffSide(path, displayed.head)
      : (doc?.text() ?? (await readDiffSide(path, displayed.local)));
  requireDisplayedText(textOnSource, model.docs[source]);
  const from = source === 0 ? "a" : "b";
  if (!indexDocument)
    return writeIndexChunk(indexPath, index, change.chunk, from, model.docs[source], ranges(source, 1));
  const current = indexDocument.status.getState();
  if (current.base?.version !== index.version || current.closing) throw staleDiff();
  requireDisplayedText(current.text, staged);
  const wasDirty = indexDocument.dirty;
  indexDocument.edit(transferChunk(change.chunk, from, model.docs[source], staged, ranges(source, 1)));
  if (!wasDirty) await indexDocument.save();
}

export function StagingDiff({
  input,
  documentOwner,
  onNeighbour,
  onJumpToSource,
  onClose,
  toolbarActions,
  metadataLoading = false,
}: DiffEditorProps & { metadataLoading?: boolean }) {
  const data = input.data as DiffData & { middle: DiffSide };
  const gitlink = hasGitlink(data);
  const shown = useEditorShown();
  const version = useVcs((s) => s.version);
  const [reload, setReload] = useState(0);
  const [loaded, setSnapshot] = useState<Snapshot | null>(null);
  const [document, setDocument] = useState<DocumentAttachment | null>(null);
  const [localText, setLocalText] = useState<string | null>(null);
  const fileStatus = gitlink ? undefined : statusOf(data.path);
  const versions = fileStatus && stagingVersions(fileStatus);
  const localSide = versions?.right ?? data.right;
  const hasLocal = !gitlink && !metadataLoading && localSide.type === "worktree";
  const local = hasLocal ? document : null;
  const localRef = useRef<DocumentAttachment | null>(null);
  const aux = auxiliaryWindow()?.kind === "diff";
  const transient = !!data.embedded || aux;
  const token = useId();
  const owner = transient ? `staging-diff:${token}` : (documentOwner ?? input.key);
  const indexPath = gitlink || metadataLoading ? null : currentStagedDiffPath(data, versions || undefined);
  const indexDoc = useStagedDiffDocument(indexPath, owner, transient);
  const indexState = useStore(indexDoc?.status ?? emptyStagedStatus);
  const full = useMemo(() => {
    if (metadataLoading || !loaded) return null;
    const [head, index, working] = loaded.model.texts;
    const indexMatches = indexDoc?.path === stripSlash(loaded.indexPath);
    const liveIndex = indexMatches && indexState.base ? indexState.text : index;
    const liveLocal = loaded.local.type === "worktree" && local ? (localText ?? working) : working;
    const base = (indexMatches && indexState.base) || loaded.index;
    if (liveIndex === index && liveLocal === working && base === loaded.index) return loaded;
    return { ...loaded, index: base, model: compareThreeTexts([head, liveIndex, liveLocal]) };
  }, [loaded, local, localText, indexDoc, indexState.base, indexState.text, metadataLoading]);
  const snapshot = useRangeSnapshot(data.stagingRange, full);
  const headSide = snapshot?.head ?? versions?.left ?? data.left;
  const headTitlePath = (headSide.type === "rev" && headSide.path) || data.path;
  const indexTitlePath = snapshot?.indexPath ?? indexPath ?? data.path;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [pendingFile, setPendingFile] = useState<0 | 1 | -1>(0);
  const applying = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEmbeddedStagedSave(!!data.embedded, indexDoc, root);
  const views = useRef<ThreePanes<EditorView> | null>(null);
  const position = useRef<{ pane: PaneIndex; line: number; col: number } | null>(null);
  const request = JSON.stringify([data.line, data.col, data.lineSide, data.reveal]);
  const revealedRequest = useRef<string | null>(null);
  const labels = useMemo<ThreePanes<string>>(
    () => [tx(sideLabel(data.left)), tx(sideLabel(data.middle)), tx(sideLabel(data.right))],
    [data.left, data.middle, data.right],
  );
  useEffect(() => {
    if (!hasLocal) return;
    let alive = true;
    let attached: DocumentAttachment | null = null;
    void attachDocument(data.path, { sharedHistory: true }).then(
      (next) => {
        if (!alive) {
          next.release();
          return;
        }
        attached = next;
        localRef.current = next;
        setLocalText(next.text());
        setDocument(next);
      },
      () => {}, // Otherwise show the available on-disk text as a preview.
    );
    return () => {
      alive = false;
      localRef.current = null;
      attached?.release();
      setDocument(null);
      setLocalText(null);
    };
  }, [data.path, hasLocal]);
  useEffect(() => {
    if (metadataLoading) return;
    let alive = true;
    void loadSnapshot(data, local)
      .then((next) => {
        if (!alive) return;
        setError("");
        setSnapshot((prev) =>
          prev?.index?.version === next.index?.version &&
          prev?.indexPath === next.indexPath &&
          sideKey(prev.head) === sideKey(next.head) &&
          sideKey(prev.local) === sideKey(next.local) &&
          next.model.texts.every((text, i) => prev.model.texts[i] === text)
            ? prev
            : next,
        );
      })
      .catch((failure) => {
        if (!alive) return;
        setSnapshot(null);
        setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [data, local, reload, version, metadataLoading]);
  useEffect(() => {
    if (!pendingFile) return;
    const timer = setTimeout(() => setPendingFile(0), 2500);
    return () => clearTimeout(timer);
  }, [pendingFile]);

  const changes = snapshot?.model.changes ?? [];
  const refresh = () => (gitlink ? void refreshNow() : setReload((value) => value + 1));
  const apply = useCallback(
    (change: ThreePaneChange, operation: Operation) => {
      if (!snapshot || applying.current) return false;
      applying.current = true;
      setBusy(true);
      void runOp(
        OPERATION_TITLE[operation],
        () => applyChange(data.path, snapshot, change, operation, () => localRef.current, indexDoc),
        { refresh: operation !== "revert" },
      ).finally(() => {
        applying.current = false;
        setBusy(false);
        setSelected(-1);
        if (operation === "revert" && localRef.current) setLocalText(localRef.current.text());
        setReload((value) => value + 1);
      });
      return true;
    },
    [data.path, indexDoc, snapshot],
  );
  const controls = useCallback(
    (change: ThreePaneChange): HunkControl[] => {
      if (!snapshot?.index || (indexDoc && !indexState.base)) return [];
      if (change.pair === 0)
        return snapshot.model.texts[0] !== null
          ? [{ pane: 0, icon: "diff-arrow-right", label: OPERATION_TITLE.unstage, run: () => apply(change, "unstage") }]
          : [];
      if (snapshot.model.texts[2] === null) return [];
      const actions: HunkControl[] = [
        { pane: 2, icon: "diff-arrow-left", label: OPERATION_TITLE.stage, run: () => apply(change, "stage") },
      ];
      if (local && !local.readOnly)
        actions.push({
          pane: 1,
          icon: "diff-arrow-right",
          label: OPERATION_TITLE.revert,
          run: () => apply(change, "revert"),
        });
      return actions;
    },
    [apply, indexDoc, indexState.base, local, snapshot],
  );

  const reveal = useCallback(
    (all: ThreePanes<EditorView>, index: number) => {
      const change = snapshot?.model.changes[index];
      if (!change) return;
      const { pair, chunk } = change;
      const target = all[1];
      const ranges = snapshot.model.ranges;
      const head = Math.min(
        target.state.doc.length,
        (ranges?.[1].from ?? 0) + (pair === 0 ? chunk.fromB : chunk.fromA),
      );
      const other = pair === 0 ? all[0] : all[2];
      const otherHead = Math.min(
        other.state.doc.length,
        (ranges?.[pair === 0 ? 0 : 2].from ?? 0) + (pair === 0 ? chunk.fromA : chunk.fromB),
      );
      other.dispatch({
        selection: { anchor: otherHead },
        effects: EditorView.scrollIntoView(otherHead, { y: "center" }),
      });
      target.dispatch({ selection: { anchor: head }, effects: EditorView.scrollIntoView(head, { y: "center" }) });
      target.focus();
      setSelected(index);
    },
    [snapshot],
  );

  const onEditors = useCallback(
    (next: ThreePanes<EditorView> | null) => {
      const previous = views.current;
      if (!next && previous) {
        const active = previous.findIndex((view) => view.hasFocus);
        if (active >= 0) {
          const { state } = previous[active]!;
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          position.current = { pane: active as PaneIndex, line: line.number - 1, col: head - line.from };
        }
      }
      views.current = next;
      if (!next || !shown) return;
      revealedRequest.current = request;
      const remembered = position.current;
      if (!remembered && data.reveal && snapshot?.model.changes.length) {
        reveal(next, data.reveal === "first" ? 0 : snapshot.model.changes.length - 1);
        return;
      }
      const initial = data.lineSide === "middle" ? 1 : data.lineSide === "left" ? 0 : 2;
      const view = next[remembered?.pane ?? initial];
      const line = view.state.doc.line(
        Math.max(1, Math.min(view.state.doc.lines, (remembered?.line ?? data.line ?? 0) + 1)),
      );
      const head = line.from + Math.min(remembered?.col ?? data.col ?? 0, line.length);
      view.dispatch({ selection: { anchor: head }, effects: EditorView.scrollIntoView(head, { y: "center" }) });
      view.focus();
      setSelected(-1);
    },
    [data.col, data.line, data.lineSide, data.reveal, request, reveal, shown, snapshot],
  );
  useEffect(() => {
    if (!shown || !views.current || revealedRequest.current === request) return;
    position.current = null;
    onEditors(views.current);
  }, [onEditors, request, shown]);

  const file = (dir: 1 | -1) => {
    const next = chainNeighbour(data, dir);
    if (!next) return;
    setPendingFile(0);
    if (onNeighbour) onNeighbour(next);
    else void openDiff(next, { preview: true });
  };
  const step = (dir: 1 | -1) => {
    if (!views.current) return;
    const index = selected < 0 && dir === -1 ? changes.length - 1 : selected + dir;
    if (index >= 0 && index < changes.length) {
      setPendingFile(0);
      reveal(views.current, index);
    } else if (pendingFile === dir) {
      file(dir);
    } else if (chainNeighbour(data, dir)) {
      setPendingFile(dir);
    }
  };
  const jumpToSource = () => {
    const local = views.current?.[2];
    if (!local || snapshot?.model.texts[2] == null) return;
    const head = local.state.selection.main.head;
    const line = local.state.doc.lineAt(head);
    void Promise.resolve(indexDoc?.save())
      .then(() => {
        onJumpToSource?.();
        return editorService().openFile(data.path, {
          focus: true,
          selection: { line: line.number - 1, col: head - line.from },
        });
      })
      .catch(() => {}); // Keep the diff open with the index draft on a failed save.
  };
  const navigator = useRef<DiffNavigator>({
    next: () => {},
    prev: () => {},
    file: () => {},
    jumpToSource: () => {},
    showSettings: () => {},
    applyChange: () => false,
    focusOpposite: () => false,
    close: () => false,
    swapSides: () => false,
    showInExternalTool: () => false,
  });
  useEffect(() => {
    const nav = navigator.current;
    nav.next = () => step(1);
    nav.prev = () => step(-1);
    nav.file = file;
    nav.jumpToSource = jumpToSource;
    nav.applyChange = (source) => {
      const change = changes[selected];
      if (!change) return false;
      const actions = controls(change);
      const action = source === "b" ? actions.find((item) => item.pane === 2) : actions.find((item) => item.pane !== 2);
      action?.run();
      return !!action;
    };
    nav.focusOpposite = () => {
      const panes = views.current;
      if (!panes) return false;
      const at = panes.findIndex((view) => view.hasFocus);
      panes[(at + 1) % panes.length]?.focus();
      return true;
    };
    nav.close = () => {
      onClose?.();
      return !!onClose;
    };
  });
  const clearFocus = () => {
    if (focusedDiffNavigator() !== navigator.current) return;
    setFocusedDiffNavigator(null);
    setContext("diffEditorFocus", false);
  };
  useEffect(() => clearFocus, []);
  return (
    <div
      ref={root}
      className={styles.root}
      tabIndex={-1}
      onFocusCapture={() => {
        setFocusedDiffNavigator(navigator.current);
        setContext("diffEditorFocus", true);
      }}
      onBlurCapture={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) clearFocus();
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Diff")} aria-busy={busy}>
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
        {!gitlink && snapshot?.model.texts[2] != null && (
          <IconButton
            icon="edit"
            title="Jump to Source"
            shortcut={shortcutLabel("diff.jumpToSource")}
            size="small"
            onClick={jumpToSource}
          />
        )}
        <IconButton icon="refresh" title="Refresh" size="small" onClick={refresh} />
        <span className={styles.count} role="status">
          {gitlink && (
            <>
              {tx("Submodule")} {"· "}
            </>
          )}
          {!full && !error && tx("Loading…")}
          {snapshot &&
            !snapshot.model.binary &&
            (changes.length === 0
              ? tx("No differences")
              : selected >= 0
                ? tx`${selected + 1} of ${changes.length} differences`
                : changes.length === 1
                  ? tx`${changes.length} difference`
                  : tx`${changes.length} differences`)}
        </span>
        {toolbarActions}
        {!aux && !data.stagingRange && getAction("vcs.showDiffInNewWindow") && (
          <IconButton
            icon="external-link"
            title="Show Diff in New Window"
            size="small"
            onClick={() =>
              void Promise.resolve(indexDoc?.save())
                .then(() => executeAction("vcs.showDiffInNewWindow", data))
                .catch(() => {})
            }
          />
        )}
        {aux && getAction("vcs.showDiffInEditorTab") && (
          <IconButton
            icon="editor-only"
            title="Show Diff in Editor Tab"
            size="small"
            onClick={() => void executeAction("vcs.showDiffInEditorTab")}
          />
        )}
      </div>
      {error && <div role="alert">{error}</div>}
      {indexDoc && indexState.error && indexState.base && (
        <div className={styles.stagedNotice} role="alert">
          <span>{indexState.error}</span>
          <Button size="small" onClick={() => void reloadStagedDocument(indexDoc)}>
            Reload Staged Version
          </Button>
        </div>
      )}
      {full && !snapshot && <div role="alert">{staleDiff().message}</div>}
      <ThreePaneDiff
        path={data.path}
        labels={labels}
        titlePaths={[
          headTitlePath === indexTitlePath ? undefined : headTitlePath,
          indexTitlePath,
          data.path === indexTitlePath ? undefined : data.path,
        ]}
        model={snapshot?.model ?? null}
        controls={controls}
        onEditors={onEditors}
        local={local}
        index={snapshot && indexState.base && indexDoc?.path === stripSlash(snapshot.indexPath) ? indexDoc : null}
        onLocalText={setLocalText}
      />
      {pendingFile !== 0 && (
        <div className={styles.navHint} role="status">
          {pendingFile === 1 ? tx("Press again to go to the next file") : tx("Press again to go to the previous file")}
        </div>
      )}
    </div>
  );
}
