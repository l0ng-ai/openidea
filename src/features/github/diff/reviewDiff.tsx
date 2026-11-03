/**
 * Review in a pull request's diff (IntelliJ's `GHPRReviewDiffExtension` with its
 * `DiffEditorModel`): a diff viewer contribution for diffs whose context is a pull request's
 * file (`PULL_REQUEST_DIFF`). For each pane it keeps
 *
 * - the inlays: the visible review threads under their lines (on their side; the unified
 *   viewer maps left lines to the right side) and the new comments being written;
 * - the gutter controls: comment icons, the "+" on commentable lines (the patch's hunks of
 *   that side, `canComment` = read access), new comments' range outlines (adjustable on the
 *   pull request's changes unless the text has a suggestion).
 *
 * It follows the pull request's data, the new comments and the settings, and adds the
 * toolbar (Refresh Review Data, Submit Review…, Previous / Next Comment), "Show Review
 * Threads" to the viewer settings and the editor menu items (Add Review Comment, Add
 * Multiline Review Comment, Mark File as Viewed). Opening it marks the file viewed when
 * "Automatically mark opened files as viewed" is on.
 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { DiffData } from "@/features/vcs/diffInput";
import type {
  DiffPaneInfo,
  DiffPaneSide,
  DiffViewerContribution,
  DiffViewerHost,
  DiffViewerPane,
} from "@/features/vcs/diffViewerProviders";
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
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import type { MenuItem } from "@/ui";
import { commitChangedFiles } from "../api/requests";
import type { GHCommitFile, GHPullRequestReviewThread } from "../api/types";
import { openPullRequestFileDiff, PULL_REQUEST_DIFF } from "../data/local";
import { setViewed } from "../data/operations";
import {
  loadPullRequestData,
  pullRequestData,
  reloadPullRequestData,
  subscribePullRequestData,
} from "../data/pullRequest";
import { currentUserHasPermission, useGhRepository } from "../data/repository";
import { containsSuggestedChange } from "../timeline/model";
import { discardNewComment, NewCommentInlay, ThreadInlay } from "./Inlays";
import {
  adjacentThread,
  commentableRanges,
  isThreadVisible,
  mapAcrossPatch,
  newCommentLocation,
  parsePatch,
  threadLocation,
  threadOrder,
  THREADS_VIEW_OPTIONS,
  type CommentLocation,
  type PatchHunk,
  type Side,
  type Span,
} from "./model";
import { newCommentsOf, requestNewComment, updateNewComment, useNewComments } from "./newComments";
import { setReviewDiffSettings, useReviewDiffSettings } from "./settings";
import { ReviewToolbar } from "./ReviewToolbar";

export interface ReviewDiffContext {
  number: number;
  /** Repository-relative path. */
  path: string;
  /** The commit whose diff this is; null for the pull request's changes. */
  commit: string | null;
}

/** The pull request file a diff shows, from its context; null for other diffs. */
export function reviewDiffContext(data: DiffData): ReviewDiffContext | null {
  const c = data.context;
  if (c?.kind !== PULL_REQUEST_DIFF || typeof c.number !== "number" || typeof c.path !== "string") return null;
  return { number: c.number, path: c.path, commit: typeof c.commit === "string" ? c.commit : null };
}

/** Tooltips of a new comment's range outline (`AdjustmentDisabledReason`). */
const outlineTooltip = (reason: "suggestion" | "commit" | null) =>
  reason === "commit"
    ? tx("Comment range cannot be adjusted while reviewing a single commit")
    : reason === "suggestion"
      ? tx("The range of this comment is not adjustable as it contains suggestion")
      : tx("Drag to select several lines for commenting");

/** The files of single commits (their patches give the commentable lines), per commit. */
const commitFiles = new Map<string, Promise<GHCommitFile[]>>();

function filesOfCommit(sha: string): Promise<GHCommitFile[]> {
  let p = commitFiles.get(sha);
  if (!p) {
    p = commitChangedFiles(sha);
    p.catch(() => commitFiles.delete(sha));
    commitFiles.set(sha, p);
  }
  return p;
}

/** Parsed patches, by patch text. */
const hunkCache = new Map<string, PatchHunk[]>();

function hunksOf(patch: string | null | undefined): PatchHunk[] {
  if (!patch) return [];
  let h = hunkCache.get(patch);
  if (!h) {
    h = parsePatch(patch);
    if (hunkCache.size > 500) hunkCache.clear();
    hunkCache.set(patch, h);
  }
  return h;
}

/** The thread Previous / Next Comment moved to last (navigation goes on from it while the caret stays). */
let navigated: { number: number; id: string; path: string; side: Side; line: number } | null = null;

/** The review diff focused last (the editor actions apply to it). */
let active: ReviewDiff | null = null;

export const activeReviewDiff = () => active;

function setActive(diff: ReviewDiff | null) {
  active = diff;
  setContext("githubReviewDiff", !!diff);
}

export class ReviewDiff implements DiffViewerContribution {
  private host: DiffViewerHost | null = null;
  /** Threads hidden with the gutter's comment icon (`Hideable`). */
  private hidden = new Set<string>();
  private commitPatch: string | null | undefined = undefined;
  private gutters = new Map<EditorView, ReviewGutterState>();
  private disposers: Array<() => void> = [];
  readonly Toolbar = () => <ReviewToolbar diff={this} />;

  constructor(readonly ctx: ReviewDiffContext) {
    const n = ctx.number;
    for (const key of ["details", "threads", "pendingReview", "changes", "viewedState"] as const)
      void loadPullRequestData(n, key).catch(() => undefined);
    if (ctx.commit)
      void filesOfCommit(ctx.commit).then(
        (files) => {
          this.commitPatch = files.find((f) => f.filename === ctx.path)?.patch ?? null;
          this.push();
        },
        () => undefined,
      );
    const push = () => this.push();
    this.disposers.push(
      subscribePullRequestData(n, push),
      useNewComments.subscribe(push),
      useReviewDiffSettings.subscribe(push),
      useGhRepository.subscribe(push),
    );
    void this.autoMarkViewed();
  }

  get number() {
    return this.ctx.number;
  }

  /** Previous / Next Comment work on the pull request's changes only (`canNavigate`). */
  get canNavigate() {
    return this.ctx.commit === null;
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (active === this) setActive(null);
  }

  extensions(pane: DiffPaneInfo): Extension {
    const side: Side = pane.unified ? "right" : pane.side;
    const focus = ViewPlugin.define((view) => {
      const onFocus = () => setActive(this);
      view.dom.addEventListener("focusin", onFocus);
      return { destroy: () => view.dom.removeEventListener("focusin", onFocus) };
    });
    return [
      lineInlays(),
      reviewGutter({
        requestNewComment: (range) => this.request(side, range),
        cancelNewComment: (line) => this.cancelAt(side, line),
        toggleComments: (line) => this.toggleAt(side, line),
        adjustRange: (key, range) =>
          updateNewComment(key, { location: newCommentLocation(side, range.start, range.end) }),
      }),
      focus,
    ];
  }

  attach(host: DiffViewerHost) {
    this.host = host;
    this.push();
    return () => {
      if (this.host === host) this.host = null;
      for (const p of host.panes()) this.gutters.delete(p.view);
    };
  }

  // ---------------------------------------------------------------------------
  // State

  private threads(): GHPullRequestReviewThread[] {
    return (pullRequestData(this.number, "threads").value ?? []).filter((t) => t.path === this.ctx.path);
  }

  /** The commentable lines of each side, once the patch is known. */
  private commentable(): Record<Side, Span[]> | null {
    if (!currentUserHasPermission("READ")) return null;
    if (this.ctx.commit) return this.commitPatch === undefined ? null : commentableRanges(hunksOf(this.commitPatch));
    const files = pullRequestData(this.number, "changes").value;
    if (!files) return null;
    return commentableRanges(hunksOf(files.find((f) => f.filename === this.ctx.path)?.patch));
  }

  /** `line` of `side` in `pane`, or null when it shows elsewhere. */
  private lineIn(pane: DiffViewerPane, side: Side, line: number): number | null {
    const at = this.host?.locate(side, line);
    return at && at.pane.view === pane.view ? at.line : null;
  }

  private outlineOf(pane: DiffViewerPane, key: string, loc: CommentLocation, text: string): ReviewOutline | null {
    const end = this.lineIn(pane, loc.side, loc.line);
    const start = this.lineIn(pane, loc.startSide, loc.startLine);
    if (end === null || start === null) return null;
    const reason = this.ctx.commit ? "commit" : containsSuggestedChange(text) ? "suggestion" : null;
    return {
      key,
      range: { start: Math.min(start, end), end: Math.max(start, end) },
      adjustable: reason === null,
      tooltip: outlineTooltip(reason),
    };
  }

  /** Recomputes and pushes every pane's inlays and gutter state. */
  push() {
    const host = this.host;
    if (!host) return;
    const n = this.number;
    const option = useReviewDiffSettings.getState().threadsView;
    const threads = this.threads();
    const drafts = newCommentsOf(n, this.ctx.path, this.ctx.commit);
    const ranges = this.commentable();
    for (const pane of host.panes()) {
      const inlays: LineInlay[] = [];
      const withComments = new Set<number>();
      const withInlays = new Set<number>();
      const withNew = new Set<number>();
      const outlines: ReviewOutline[] = [];
      for (const t of threads) {
        const loc = isThreadVisible(t, option) ? threadLocation(t, this.ctx) : null;
        const line = loc && this.lineIn(pane, loc.side, loc.line);
        if (line == null) continue;
        withComments.add(line);
        if (this.hidden.has(t.id)) continue;
        withInlays.add(line);
        inlays.push({ key: t.id, line, content: <ThreadInlay number={n} threadId={t.id} /> });
      }
      for (const c of drafts) {
        const line = this.lineIn(pane, c.location.side, c.location.line);
        if (line === null) continue;
        withNew.add(line);
        withInlays.add(line);
        inlays.push({ key: c.id, line, content: <NewCommentInlay id={c.id} /> });
        const outline = this.outlineOf(pane, c.id, c.location, c.text);
        if (outline) outlines.push(outline);
      }
      const gutter: ReviewGutterState = {
        linesWithComments: withComments,
        linesWithNewComments: withNew,
        linesWithInlays: withInlays,
        // The unified viewer's lines are the right side's.
        commentable: ranges ? ranges[host.mode === "unified" ? "right" : pane.side] : [],
        outlines,
      };
      this.gutters.set(pane.view, gutter);
      pane.view.dispatch({ effects: [setLineInlays.of(inlays), setReviewGutterState.of(gutter)] });
    }
  }

  private gutterOf(view: EditorView): ReviewGutterState {
    return this.gutters.get(view) ?? EMPTY_REVIEW_GUTTER;
  }

  private paneOf(side: Side): DiffViewerPane | null {
    const panes = this.host?.panes() ?? [];
    return panes.find((p) => p.side === side) ?? (this.host?.mode === "unified" ? (panes[0] ?? null) : null);
  }

  // ---------------------------------------------------------------------------
  // Gutter requests (lines of the pane showing `side`)

  private request(side: Side, range: LineRange) {
    requestNewComment(this.number, this.ctx.path, this.ctx.commit, newCommentLocation(side, range.start, range.end));
  }

  private cancelAt(side: Side, line: number) {
    const c = newCommentsOf(this.number, this.ctx.path, this.ctx.commit).find(
      (x) => x.location.side === side && x.location.line === line,
    );
    if (c) void discardNewComment(c);
  }

  /** Shows the threads of the line, or hides them when any is shown (`syncOrToggleAll`). */
  private toggleAt(side: Side, line: number) {
    const pane = this.paneOf(side);
    if (!pane) return;
    const ids = this.threads()
      .filter((t) => {
        const loc = threadLocation(t, this.ctx);
        return !!loc && this.lineIn(pane, loc.side, loc.line) === line;
      })
      .map((t) => t.id);
    const anyShown = ids.some((id) => !this.hidden.has(id));
    for (const id of ids) {
      if (anyShown) this.hidden.add(id);
      else this.hidden.delete(id);
    }
    this.push();
  }

  // ---------------------------------------------------------------------------
  // Actions

  /** "Add Review Comment" on the caret's line, "Add Multiline Review Comment" on the selected lines. */
  addComment(multiline: boolean, at?: { pane: DiffViewerPane; line: number }) {
    const pane = at?.pane ?? this.host?.focusedPane();
    if (!pane) return;
    const range = this.commentRange(pane, multiline, at?.line);
    if (range) this.request(this.host?.mode === "unified" ? "right" : pane.side, range);
  }

  /** The range the actions would comment on, when they can. */
  commentRange(pane: DiffViewerPane, multiline: boolean, line?: number): LineRange | null {
    const state = pane.view.state;
    const sel = state.selection.main;
    const gutter = this.gutterOf(pane.view);
    if (multiline) {
      const range = { start: state.doc.lineAt(sel.from).number - 1, end: state.doc.lineAt(sel.to).number - 1 };
      return range.start < range.end && canCreateComment(gutter, range) ? range : null;
    }
    const l = line ?? state.doc.lineAt(sel.head).number - 1;
    return isLineCommentable(gutter, l) ? { start: l, end: l } : null;
  }

  /** "Mark File as Viewed" / "Mark File as Not Viewed": the current state, null without one (a commit's diff). */
  viewed(): boolean | null {
    if (this.ctx.commit) return null;
    const state = pullRequestData(this.number, "viewedState").value;
    return state ? state[this.ctx.path] === "VIEWED" : null;
  }

  toggleViewed() {
    const viewed = this.viewed();
    if (viewed !== null) void setViewed(this.number, [this.ctx.path], !viewed).catch(() => undefined);
  }

  private async autoMarkViewed() {
    if (this.ctx.commit || !useReviewDiffSettings.getState().autoMarkViewed) return;
    try {
      const state = await loadPullRequestData(this.number, "viewedState");
      if (state[this.ctx.path] !== "VIEWED") await setViewed(this.number, [this.ctx.path], true);
    } catch {
      /* IntelliJ ignores it too */
    }
  }

  /** "Refresh Review Data": the pending review and the threads. */
  refresh() {
    void reloadPullRequestData(this.number, "pendingReview").catch(() => undefined);
    void reloadPullRequestData(this.number, "threads").catch(() => undefined);
  }

  /** Previous / Next Comment: the visible thread before / after the current one or the caret, in any file. */
  async gotoComment(dir: 1 | -1): Promise<boolean> {
    const host = this.host;
    if (!host || !this.canNavigate) return false;
    const n = this.number;
    const [files, threads] = await Promise.all([loadPullRequestData(n, "changes"), loadPullRequestData(n, "threads")]);
    const option = useReviewDiffSettings.getState().threadsView;
    const order = threadOrder(
      files.map((f) => ({ path: f.filename, hunks: hunksOf(f.patch) })),
      threads,
    );
    const visible = (id: string) => {
      const t = threads.find((x) => x.id === id);
      return !!t && isThreadVisible(t, option);
    };
    const pane = host.focusedPane();
    const side: Side = host.mode === "unified" ? "right" : pane.side;
    const line = pane.view.state.doc.lineAt(pane.view.state.selection.main.head).number - 1;
    const onLast =
      navigated?.number === n && navigated.path === this.ctx.path && navigated.side === side && navigated.line === line;
    const file = files.findIndex((f) => f.filename === this.ctx.path);
    const other = host.mapLine(side, line);
    const from = onLast
      ? { id: navigated!.id }
      : { file, left: side === "left" ? line : other, right: side === "right" ? line : other };
    const target = adjacentThread(order, from, dir, visible);
    if (!target) return false;
    // Where the caret lands: the unified viewer shows left lines at their right-side line.
    const mapped = host.mode === "unified" && target.side === "left";
    const caretAt = (rightLine: number) => (mapped ? { side: "right" as const, line: rightLine } : target);
    if (target.path === this.ctx.path) {
      const at = caretAt(host.mapLine("left", target.line));
      navigated = { number: n, id: target.id, path: target.path, side: at.side, line: at.line };
      this.hidden.delete(target.id);
      this.push();
      host.reveal(target.side, target.line);
    } else {
      const hunks = hunksOf(files.find((f) => f.filename === target.path)?.patch);
      const at = caretAt(mapAcrossPatch(hunks, "left", target.line));
      navigated = { number: n, id: target.id, path: target.path, side: at.side, line: at.line };
      await openPullRequestFileDiff(n, target.path, { line: target.line, side: target.side });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Viewer settings and menus

  settingsItems(): MenuItem[] {
    const current = useReviewDiffSettings.getState().threadsView;
    return [
      {
        id: "github.reviewThreads",
        label: "Show Review Threads",
        icon: "eye",
        submenu: THREADS_VIEW_OPTIONS.map((o) => ({
          id: o.value,
          label: o.label,
          checked: current === o.value,
          run: () => setReviewDiffSettings({ threadsView: o.value }),
        })),
      },
    ];
  }

  contextMenuItems(at: { side: DiffPaneSide; line: number }): MenuItem[] {
    const pane = this.host?.panes().find((p) => p.side === at.side);
    if (!pane) return [];
    const viewed = this.viewed();
    return [
      {
        id: "github.addReviewComment",
        label: "Add Review Comment",
        disabled: !this.commentRange(pane, false, at.line),
        run: () => this.addComment(false, { pane, line: at.line }),
      },
      {
        id: "github.addMultilineReviewComment",
        label: "Add Multiline Review Comment",
        disabled: !this.commentRange(pane, true),
        run: () => this.addComment(true, { pane, line: at.line }),
      },
      ...(viewed === null
        ? []
        : [
            {
              id: "github.toggleViewed",
              label: viewed ? "Mark File as Not Viewed" : "Mark File as Viewed",
              shortcut: shortcutLabel("github.pullRequest.toggleViewed"),
              run: () => this.toggleViewed(),
            },
          ]),
    ];
  }
}

export function createReviewDiff(data: DiffData): ReviewDiff | null {
  const ctx = reviewDiffContext(data);
  return ctx ? new ReviewDiff(ctx) : null;
}
