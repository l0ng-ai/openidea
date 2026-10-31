/**
 * Review in the regular editor (IntelliJ's `GHPRReviewInEditorController` with
 * `GHPRReviewFileEditorModel`): an editor contribution for the files of the current
 * branch's pull request. Such an editor gets the "Review Mode" group at its top-right
 * (`showReviewToolbarWithActions`: Previous / Next Comment and the mode's menu); while review
 * mode is on and the branch is in sync it also gets
 *
 * - the review threads (right side, current) as inlays under their lines,
 * - the gutter "+" on commentable lines (the patch's hunks) with the new-comment inlays the
 *   diff uses (Start Review / Add Single Comment / Add Review Comment),
 * - change markers of the review's changes (vs the pull request's base) in the change lane,
 *   under the local ones.
 *
 * Lines are carried from the review head to the document through the diff of the head's
 * text and the document (`trackDocumentDiffSync`), recomputed as the document changes.
 */
import { Compartment, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { LaneMarker, editorCorner, gutterLaneMarkers, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { lineInlays, setLineInlays, type LineInlay } from "@/features/vcs/lineInlays";
import {
  EMPTY_REVIEW_GUTTER,
  canCreateComment,
  isLineCommentable,
  reviewGutter,
  setReviewGutterState,
  type LineRange,
  type ReviewGutterState,
  type ReviewOutline,
} from "@/features/vcs/reviewGutter";
import { currentRepoRoot } from "@/features/vcs/store";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { maybeEditorService } from "@/workbench/contributions";
import type { GHCommitFile, GHPullRequestReviewThread } from "../api/types";
import { openPullRequestFileDiff } from "../data/local";
import {
  loadPullRequestData,
  pullRequestData,
  reloadPullRequestData,
  subscribePullRequestData,
} from "../data/pullRequest";
import { currentUserHasPermission, useGhRepository } from "../data/repository";
import { discardNewComment, NewCommentInlay, ThreadInlay } from "../diff/Inlays";
import { adjacentThread, newCommentLocation, parsePatch, threadOrder, type PatchHunk } from "../diff/model";
import { newCommentsOf, requestNewComment, updateNewComment, useNewComments } from "../diff/newComments";
import { containsSuggestedChange } from "../timeline/model";
import {
  documentChanges,
  editorThreadRange,
  hunksToRanges,
  lineFromAfter,
  lineToAfter,
  patchChanges,
  patchRanges,
  shiftRanges,
  type ChangeKind,
  type DocumentChange,
  type Range,
} from "./model";
import { useReviewModeSettings } from "./settings";
import { useReviewBranch } from "./state";
import { ReviewModeToolbar } from "./Toolbar";

/** Parsed patches, by patch text. */
const hunkCache = new Map<string, PatchHunk[]>();

function hunksOf(patch: string | null | undefined): PatchHunk[] {
  if (!patch) return [];
  let h = hunkCache.get(patch);
  if (!h) {
    h = parsePatch(patch);
    if (hunkCache.size > 200) hunkCache.clear();
    hunkCache.set(patch, h);
  }
  return h;
}

/** Path relative to the repository root; null outside it. */
function repositoryPath(path: string): string | null {
  const root = currentRepoRoot();
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

// ---------------------------------------------------------------------------
// Review change markers

const setReviewChanges = StateEffect.define<readonly DocumentChange[]>();

const LANE: Record<ChangeKind, LaneMarker> = {
  added: new LaneMarker("var(--gutter-added)"),
  modified: new LaneMarker("var(--gutter-modified)"),
  deleted: new LaneMarker("var(--gutter-deleted)", "deleted"),
};

const reviewChanges = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setReviewChanges)) continue;
      const doc = tr.state.doc;
      const ranges = [];
      for (const c of e.value) {
        if (c.kind === "deleted" || c.end <= c.start) {
          ranges.push(LANE.deleted.range(doc.line(Math.min(Math.max(c.start, 0), doc.lines - 1) + 1).from));
          continue;
        }
        for (let l = c.start; l < c.end && l < doc.lines; l++) ranges.push(LANE[c.kind].range(doc.line(l + 1).from));
      }
      return RangeSet.of(ranges, true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

/** The review's extensions, installed while it is shown. */
function reviewExtensions(editor: ReviewEditor): Extension {
  return [
    lineInlays(),
    reviewGutter({
      requestNewComment: (range) => editor.request(range),
      cancelNewComment: (line) => editor.cancelAt(line),
      toggleComments: (line) => editor.toggleAt(line),
      adjustRange: (key, range) => editor.adjust(key, range),
    }),
    reviewChanges,
    gutterLaneMarkers.from(reviewChanges),
  ];
}

// ---------------------------------------------------------------------------

const compartment = new Compartment();
const editors = new Map<EditorView, ReviewEditor>();

/** The review in the active text editor, when it is shown. */
export function activeReviewEditor(): ReviewEditor | null {
  const view = useEditorRegistry.getState().active?.view;
  const editor = view ? editors.get(view) : undefined;
  return editor?.shown ? editor : null;
}

/** The review of the active text editor's file, shown or not (Show Review Diff). */
export function activeReviewFile(): ReviewEditor | null {
  const view = useEditorRegistry.getState().active?.view;
  const editor = view ? editors.get(view) : undefined;
  return editor?.number != null ? editor : null;
}

/** Keeps `githubReviewEditor` (the active editor shows a review) up to date. */
export function trackActiveReviewEditor(): () => void {
  const sync = () => setContext("githubReviewEditor", !!activeReviewEditor());
  sync();
  const unsub = useEditorRegistry.subscribe((s, prev) => {
    if (s.active !== prev.active) sync();
  });
  return () => {
    unsub();
    setContext("githubReviewEditor", false);
  };
}

/** The thread Previous / Next Comment moved to last (navigation goes on from it while the caret stays). */
let navigated: { number: number; id: string; path: string; line: number } | null = null;

/** `GHPRReviewFileEditorModel` for one editor. */
export class ReviewEditor {
  /** The pull request file this editor shows, when it is one. */
  number: number | null = null;
  file: GHCommitFile | null = null;
  /** The review is shown (review mode on, the branch in sync, the head's text known). */
  shown = false;
  /** The head revision's text, for `headOid`. */
  private head: { oid: string; text: string | null } | null = null;
  /** Document changes since the review head (`postReviewRanges`); null until computed. */
  private local: Range[] | null = null;
  private hidden = new Set<string>();
  private gutter: ReviewGutterState = EMPTY_REVIEW_GUTTER;
  private installed = false;
  private toolbar: { el: HTMLElement; root: Root } | null = null;
  private stopData: (() => void) | null = null;
  private dataFor: number | null = null;
  private disposers: Array<() => void> = [];
  private diffTimer: ReturnType<typeof setTimeout> | undefined;
  private diffSeq = 0;
  private scheduled = false;
  private destroyed = false;

  constructor(
    readonly view: EditorView,
    readonly path: string,
  ) {
    editors.set(view, this);
    const schedule = () => this.schedule();
    this.disposers.push(
      useReviewBranch.subscribe(schedule),
      useReviewModeSettings.subscribe(schedule),
      useNewComments.subscribe(schedule),
      useGhRepository.subscribe(schedule),
    );
    this.schedule();
  }

  get relativePath(): string | null {
    return repositoryPath(this.path);
  }

  /** Recomputes on the next microtask (state changes come in bursts). */
  schedule() {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.destroyed) this.sync();
    });
  }

  update(u: ViewUpdate) {
    if (u.docChanged && this.shown) {
      clearTimeout(this.diffTimer);
      this.diffTimer = setTimeout(() => void this.computeLocal(), 150);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.diffTimer);
    editors.delete(this.view);
    this.disposers.forEach((d) => d());
    this.stopData?.();
    this.unmountToolbar();
  }

  private followData(n: number | null) {
    if (this.dataFor === n) return;
    this.stopData?.();
    this.stopData = null;
    this.dataFor = n;
    if (n === null) return;
    this.stopData = subscribePullRequestData(n, () => this.schedule());
    void loadPullRequestData(n, "changes").catch(() => undefined);
  }

  private sync() {
    const branch = useReviewBranch.getState();
    const n = useGhRepository.getState().connection ? branch.number : null;
    this.followData(n);
    const rel = this.relativePath;
    const files = n === null ? undefined : pullRequestData(n, "changes").value;
    const file = (rel && files?.find((f) => f.filename === rel && f.status !== "removed")) || null;
    this.number = file ? n : null;
    this.file = file;
    if (this.number === null) {
      this.unmountToolbar();
      this.hide();
      return;
    }
    this.mountToolbar();
    const settings = useReviewModeSettings.getState();
    if (!settings.enabled || branch.updateRequired) {
      this.hide();
      return;
    }
    for (const key of ["details", "threads", "pendingReview"] as const)
      void loadPullRequestData(this.number, key).catch(() => undefined);
    const oid = pullRequestData(this.number, "details").value?.headRefOid;
    if (!oid) return;
    if (this.head?.oid !== oid) {
      void this.loadHead(oid);
      return;
    }
    if (this.head.text === null) return;
    if (!this.local) {
      void this.computeLocal();
      return;
    }
    this.show();
  }

  private async loadHead(oid: string) {
    this.head = { oid, text: null };
    this.local = null;
    try {
      const text = await call(commands.vcsFileAt(this.path, oid));
      if (this.head?.oid !== oid) return;
      this.head = { oid, text: (text ?? "").replace(/\r\n?/g, "\n") };
    } catch {
      if (this.head?.oid === oid) this.head = null;
      return;
    }
    this.schedule();
  }

  /** The document's changes against the review head (`trackDocumentDiffSync`). */
  private async computeLocal() {
    const head = this.head?.text;
    if (head == null) return;
    const seq = ++this.diffSeq;
    const doc = this.view.state.doc.toString();
    let ranges: Range[];
    try {
      ranges = head === doc ? [] : hunksToRanges(await commands.vcsDiffHunks(head, doc));
    } catch {
      return;
    }
    if (seq !== this.diffSeq || this.destroyed) return;
    this.local = ranges;
    this.schedule();
  }

  private mountToolbar() {
    if (this.toolbar) {
      this.toolbar.root.render(<ReviewModeToolbar editor={this} />);
      return;
    }
    const el = document.createElement("div");
    el.className = "cm-openidea-reviewMode";
    // Before the inspection widget (`Constraints.FIRST`).
    el.style.order = "-1";
    editorCorner(this.view).appendChild(el);
    const root = createRoot(el);
    root.render(<ReviewModeToolbar editor={this} />);
    this.toolbar = { el, root };
  }

  private unmountToolbar() {
    const t = this.toolbar;
    if (!t) return;
    this.toolbar = null;
    t.el.remove();
    queueMicrotask(() => t.root.unmount());
  }

  private hide() {
    if (!this.installed) return;
    this.installed = false;
    this.shown = false;
    this.gutter = EMPTY_REVIEW_GUTTER;
    this.view.dispatch({ effects: compartment.reconfigure([]) });
    if (useEditorRegistry.getState().active?.view === this.view) setContext("githubReviewEditor", false);
  }

  /** The review head's lines in the document (`postReviewRanges`). */
  private get ranges(): Range[] {
    return this.local ?? [];
  }

  private threads(): GHPullRequestReviewThread[] {
    if (this.number === null) return [];
    const option = useReviewModeSettings.getState().threads;
    return (pullRequestData(this.number, "threads").value ?? []).filter(
      (t) => t.path === this.file?.filename && (option === "all" || !t.isResolved),
    );
  }

  /** The visible threads with their document line. */
  private placedThreads(): Array<{ thread: GHPullRequestReviewThread; line: number }> {
    const out = [];
    for (const thread of this.threads()) {
      const r = editorThreadRange(thread);
      if (r) out.push({ thread, line: lineToAfter(this.ranges, r.end) });
    }
    return out;
  }

  private show() {
    const n = this.number;
    const file = this.file;
    if (n === null || !file) return;
    if (!this.installed) {
      this.installed = true;
      this.view.dispatch({ effects: compartment.reconfigure(reviewExtensions(this)) });
    }
    this.shown = true;
    if (useEditorRegistry.getState().active?.view === this.view) setContext("githubReviewEditor", true);
    const ranges = this.ranges;
    const hunks = hunksOf(file.patch);
    const inlays: LineInlay[] = [];
    const withComments = new Set<number>();
    const withInlays = new Set<number>();
    const withNew = new Set<number>();
    const outlines: ReviewOutline[] = [];
    for (const { thread, line } of this.placedThreads()) {
      withComments.add(line);
      if (this.hidden.has(thread.id)) continue;
      withInlays.add(line);
      inlays.push({ key: thread.id, line, content: <ThreadInlay number={n} threadId={thread.id} /> });
    }
    for (const c of newCommentsOf(n, file.filename, null)) {
      const loc = c.location;
      if (loc.side !== "right" || loc.startSide !== "right") continue;
      const line = lineToAfter(ranges, loc.line);
      const start = lineToAfter(ranges, loc.startLine);
      withNew.add(line);
      withInlays.add(line);
      inlays.push({ key: c.id, line, content: <NewCommentInlay id={c.id} /> });
      const suggestion = containsSuggestedChange(c.text);
      outlines.push({
        key: c.id,
        range: { start: Math.min(start, line), end: Math.max(start, line) },
        adjustable: !suggestion,
        tooltip: suggestion
          ? tx("The range of this comment is not adjustable as it contains suggestion")
          : tx("Drag to select several lines for commenting"),
      });
    }
    const commentable = currentUserHasPermission("READ")
      ? shiftRanges(patchRanges(hunks), ranges).map((r) => ({ start: r.start2, end: r.end2 }))
      : [];
    this.gutter = {
      linesWithComments: withComments,
      linesWithNewComments: withNew,
      linesWithInlays: withInlays,
      commentable,
      outlines,
    };
    this.view.dispatch({
      effects: [
        setLineInlays.of(inlays),
        setReviewGutterState.of(this.gutter),
        setReviewChanges.of(documentChanges(shiftRanges(patchChanges(hunks), ranges))),
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Gutter requests (document lines)

  /** Document lines as review head lines; null when one was added locally. */
  private toHead(range: LineRange): LineRange | null {
    const start = lineFromAfter(this.ranges, range.start);
    const end = lineFromAfter(this.ranges, range.end);
    return start === null || end === null || start < 0 || end < 0 ? null : { start, end };
  }

  request(range: LineRange) {
    const head = this.toHead(range);
    if (this.number === null || !this.file || !head) return;
    requestNewComment(this.number, this.file.filename, null, newCommentLocation("right", head.start, head.end));
  }

  cancelAt(line: number) {
    const head = lineFromAfter(this.ranges, line);
    if (this.number === null || !this.file || head === null) return;
    const c = newCommentsOf(this.number, this.file.filename, null).find(
      (x) => x.location.side === "right" && x.location.line === head,
    );
    if (c) void discardNewComment(c);
  }

  adjust(key: string, range: LineRange) {
    const head = this.toHead(range);
    if (head) updateNewComment(key, { location: newCommentLocation("right", head.start, head.end) });
  }

  /** Shows the threads of the line, or hides them when any is shown (`syncOrToggleAll`). */
  toggleAt(line: number) {
    const ids = this.placedThreads()
      .filter((p) => p.line === line)
      .map((p) => p.thread.id);
    const anyShown = ids.some((id) => !this.hidden.has(id));
    for (const id of ids) {
      if (anyShown) this.hidden.add(id);
      else this.hidden.delete(id);
    }
    this.show();
  }

  // ---------------------------------------------------------------------------
  // Actions

  private caretLine(): number {
    const s = this.view.state;
    return s.doc.lineAt(s.selection.main.head).number - 1;
  }

  /** "Add Review Comment" on the caret's line, "Add Multiline Review Comment" on the selected lines. */
  addComment(multiline: boolean) {
    const s = this.view.state;
    const sel = s.selection.main;
    const range = multiline
      ? { start: s.doc.lineAt(sel.from).number - 1, end: s.doc.lineAt(sel.to).number - 1 }
      : { start: this.caretLine(), end: this.caretLine() };
    if (
      multiline
        ? range.start < range.end && canCreateComment(this.gutter, range)
        : isLineCommentable(this.gutter, range.start)
    )
      this.request(range);
  }

  /** "Refresh Review Data": the pending review and the threads. */
  refresh() {
    if (this.number === null) return;
    void reloadPullRequestData(this.number, "pendingReview").catch(() => undefined);
    void reloadPullRequestData(this.number, "threads").catch(() => undefined);
  }

  /** "Show Review Diff": the pull request's diff of this file at the caret's line. */
  showDiff() {
    if (this.number === null || !this.file) return;
    const line = this.shown ? lineFromAfter(this.ranges, this.caretLine(), true) : null;
    void openPullRequestFileDiff(this.number, this.file.filename, line === null ? {} : { line, side: "right" });
  }

  /** Previous / Next Comment: the visible thread before / after the current one or the caret, in any file. */
  async gotoComment(dir: 1 | -1): Promise<boolean> {
    const n = this.number;
    const file = this.file;
    if (n === null || !file || !this.shown) return false;
    const [files, threads] = await Promise.all([loadPullRequestData(n, "changes"), loadPullRequestData(n, "threads")]);
    const option = useReviewModeSettings.getState().threads;
    const order = threadOrder(
      files.map((f) => ({ path: f.filename, hunks: hunksOf(f.patch) })),
      threads,
    );
    const visible = (id: string) => {
      const t = threads.find((x) => x.id === id);
      return !!t && (option === "all" || !t.isResolved) && !!editorThreadRange(t);
    };
    const caret = this.caretLine();
    const onLast = navigated?.number === n && navigated.path === file.filename && navigated.line === caret;
    // `lineToUnified`: the left line doesn't matter, but at the start so the line's first thread is next.
    const right = lineFromAfter(this.ranges, caret, true) ?? 0;
    const from = onLast
      ? { id: navigated!.id }
      : { file: files.findIndex((f) => f.filename === file.filename), left: -1, right };
    const target = adjacentThread(order, from, dir, visible);
    if (!target) return false;
    if (target.path === file.filename) {
      const line = lineToAfter(this.ranges, target.line);
      navigated = { number: n, id: target.id, path: target.path, line };
      this.hidden.delete(target.id);
      this.show();
      const pos = this.view.state.doc.line(Math.min(line + 1, this.view.state.doc.lines)).from;
      this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      this.view.focus();
    } else {
      // Another file's local changes are not known here: its head line is the best guess.
      navigated = { number: n, id: target.id, path: target.path, line: target.line };
      const root = currentRepoRoot();
      if (root)
        await maybeEditorService()?.openFile(`${root}/${target.path}`, {
          selection: { line: target.line, col: 0 },
          focus: true,
        });
    }
    return true;
  }
}

/** The editor contribution: every file editor gets the review when its file is in the pull request. */
export function reviewModeEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.doc < 0) return [];
  return [compartment.of([]), ViewPlugin.define((view) => new ReviewEditor(view, ctx.path))];
}
