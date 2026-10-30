import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LineHunk } from "@/bindings";

const ghApi = vi.fn();
const config: Record<string, string | null> = {};
let mergeBase: string | null = "head";
let diffHunks: (oldText: string, newText: string) => LineHunk[] = () => [];
const checkout = vi.fn();

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      ghApi: (req: unknown) => ghApi(req),
      vcsFileAt: () => ok(HEAD),
      vcsDiffHunks: (a: string, b: string) => Promise.resolve(diffHunks(a, b)),
      vcsConfigGet: (_repo: string | null, key: string) => ok(config[key] ?? null),
      vcsRemotes: () =>
        ok([
          { name: "origin", url: "git@github.com:o/r.git" },
          { name: "fork", url: "https://github.com/alice/r.git" },
        ]),
      vcsMergeBase: () => ok(mergeBase),
      ghPrCheckout: (...args: unknown[]) => {
        checkout(...args);
        return ok(null);
      },
    },
  };
});

import { useEditorRegistry } from "@/editor/api";
import { useBranchWidgetExtensions } from "@/features/vcs/branchWidgetExtensions";
import { useVcs } from "@/features/vcs/store";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { setCurrentRepository } from "../api/client";
import type {
  GHCommitFile,
  GHPullRequest,
  GHPullRequestReviewComment,
  GHPullRequestReviewThread,
  GHRepository,
  GHUser,
} from "../api/types";
import { clearNewComments, useNewComments } from "../diff/newComments";
import { parsePatch } from "../diff/model";
import { clearPullRequests, setPullRequestData } from "../data/pullRequest";
import { useGhRepository } from "../data/repository";
import { activeReviewEditor, reviewModeEditorExtension } from "./editor";
import {
  documentChanges,
  editorThreadRange,
  hunksToRanges,
  isUpdateRequired,
  lineFromAfter,
  lineToAfter,
  openPullRequestQuery,
  patchChanges,
  patchRanges,
  shiftRanges,
  trackedBranch,
} from "./model";
import { activateReviewMode } from ".";
import { setReviewModeEnabled, useReviewModeSettings } from "./settings";
import { refreshCurrentBranchPullRequest, updateReviewBranch, useReviewBranch } from "./state";

const N = 12;
const PATH = "src/a.ts";
const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const HEAD = BASE.replace("line 3\n", "line three\n");
const PATCH = "@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+line three\n line 4\n line 5\n line 6";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };

const comment = (body: string): GHPullRequestReviewComment =>
  ({
    id: `C-${body}`,
    author: { __typename: "User", login: "alice", url: "", avatarUrl: "" },
    body,
    createdAt: "2026-10-01T10:00:00Z",
    url: "",
    state: "SUBMITTED",
    commit: { oid: "head", abbreviatedOid: "head" },
    originalCommit: { oid: "head", abbreviatedOid: "head" },
    diffHunk: "",
    pullRequestReview: { id: "R0" },
    viewerCanDelete: false,
    viewerCanUpdate: false,
    viewerCanReact: false,
    reactions: { nodes: [] },
  }) as unknown as GHPullRequestReviewComment;

const thread = (id: string, line: number, over: Partial<GHPullRequestReviewThread> = {}) =>
  ({
    id,
    isResolved: false,
    isOutdated: false,
    path: PATH,
    subjectType: "LINE",
    diffSide: "RIGHT",
    line,
    originalLine: line,
    startDiffSide: null,
    startLine: null,
    originalStartLine: null,
    comments: { nodes: [comment(`body of ${id}`)] },
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    ...over,
  }) as GHPullRequestReviewThread;

const file: GHCommitFile = {
  sha: null,
  filename: PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: PATCH,
  previousFilename: null,
};

// ---------------------------------------------------------------------------

describe("model", () => {
  const remotes = [
    { name: "origin", url: "git@github.com:o/r.git" },
    { name: "fork", url: "https://github.com/alice/r.git" },
  ];

  it("finds the tracked remote branch from the branch's config", () => {
    expect(trackedBranch("origin", "refs/heads/feature/x", remotes)).toEqual({
      repository: { owner: "o", name: "r" },
      branch: "feature/x",
      pullRequest: null,
    });
    // gh sets a URL as the remote of a fork's branch.
    expect(trackedBranch("https://github.com/bob/r.git", "refs/heads/fix", remotes)?.repository).toEqual({
      owner: "bob",
      name: "r",
    });
    expect(trackedBranch("origin", "refs/pull/7/head", remotes)).toMatchObject({ pullRequest: 7, branch: null });
    expect(trackedBranch(null, null, remotes)).toBeNull();
    expect(trackedBranch(".", "refs/heads/main", remotes)).toBeNull();
    const alias = [{ name: "origin", url: "git@work-github:o/r.git" }];
    expect(trackedBranch("origin", "refs/heads/x", alias)).toBeNull();
    expect(trackedBranch("origin", "refs/heads/x", alias, { owner: "o", name: "r" })?.repository).toEqual({
      owner: "o",
      name: "r",
    });
    expect(trackedBranch("gitlab", "refs/heads/x", [{ name: "gitlab", url: "git@gitlab.com:o/r.git" }])).toBeNull();
  });

  it("queries the open pull request with the head owner:branch", () => {
    const tracked = trackedBranch("fork", "refs/heads/a b", remotes)!;
    expect(openPullRequestQuery({ owner: "o", name: "r" }, tracked)).toBe(
      "repos/o/r/pulls?state=open&head=alice%3Aa%20b&per_page=1",
    );
  });

  it("requires an update when the head is not in the local history", () => {
    expect(isUpdateRequired("abc", "abc")).toBe(false);
    expect(isUpdateRequired("ABC", "abc")).toBe(false);
    expect(isUpdateRequired("abc", "def")).toBe(true);
    expect(isUpdateRequired("abc", null)).toBe(true);
  });

  it("takes the patch's changes without context and its commentable ranges", () => {
    const hunks = parsePatch("@@ -1,5 +1,6 @@\n a\n-b\n+B\n+B2\n c\n-d\n e");
    expect(patchChanges(hunks)).toEqual([
      { start1: 1, end1: 2, start2: 1, end2: 3 },
      { start1: 3, end1: 4, start2: 4, end2: 4 },
    ]);
    expect(documentChanges(patchChanges(hunks)).map((c) => c.kind)).toEqual(["modified", "deleted"]);
    expect(patchRanges(hunks)).toEqual([{ start1: 0, end1: 5, start2: 0, end2: 6 }]);
  });

  it("carries lines across local changes and back", () => {
    // Two lines inserted at 2, line 6 changed into two.
    const ranges = hunksToRanges([
      { start: 2, lines: 2, oldStart: 2, oldLines: 0 },
      { start: 8, lines: 2, oldStart: 6, oldLines: 1 },
    ]);
    expect([0, 1, 2, 5, 6, 7].map((l) => lineToAfter(ranges, l))).toEqual([0, 1, 4, 7, 9, 10]);
    expect(lineFromAfter(ranges, 4)).toBe(2);
    expect(lineFromAfter(ranges, 2)).toBeNull();
    expect(lineFromAfter(ranges, 2, true)).toBe(2);
    expect(lineFromAfter(ranges, 10)).toBe(7);
  });

  it("shifts review ranges over local changes, leaving out what they changed again", () => {
    const review = [
      { start1: 0, end1: 0, start2: 2, end2: 4 },
      { start1: 5, end1: 6, start2: 8, end2: 9 },
    ];
    // One line inserted at the top; the second review change edited locally.
    const local = [
      { start1: 0, end1: 0, start2: 0, end2: 1 },
      { start1: 8, end1: 9, start2: 9, end2: 11 },
    ];
    expect(shiftRanges(review, local)).toEqual([{ start1: 0, end1: 0, start2: 3, end2: 5 }]);
    // A local edit inside a review range splits it.
    expect(
      shiftRanges([{ start1: 0, end1: 10, start2: 0, end2: 10 }], [{ start1: 4, end1: 5, start2: 4, end2: 4 }]),
    ).toEqual([
      { start1: 0, end1: 10, start2: 0, end2: 4 },
      { start1: 0, end1: 10, start2: 4, end2: 9 },
    ]);
  });

  it("places current right-side threads only", () => {
    expect(editorThreadRange(thread("a", 4))).toEqual({ start: 3, end: 3 });
    expect(editorThreadRange(thread("a", 6, { startLine: 4, startDiffSide: "RIGHT" }))).toEqual({ start: 3, end: 5 });
    expect(editorThreadRange(thread("a", 4, { diffSide: "LEFT" }))).toBeNull();
    expect(editorThreadRange(thread("a", 4, { isOutdated: true }))).toBeNull();
    expect(editorThreadRange(thread("a", 4, { subjectType: "FILE" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function calls(op: RegExp) {
  return ghApi.mock.calls
    .map(([req]) => req as { endpoint: string; body?: string })
    .filter((r) => op.test(r.endpoint === "graphql" ? (JSON.parse(r.body!) as { query: string }).query : r.endpoint))
    .map((r) =>
      r.endpoint === "graphql" ? (JSON.parse(r.body!) as { variables: Record<string, unknown> }).variables : r,
    );
}

let restPulls: unknown = [{ number: N }];

function respond(req: {
  endpoint: string;
  body?: string;
}): { status: "ok"; data: string } | { status: "error"; error: unknown } {
  if (req.endpoint.startsWith("repos/o/r/pulls?")) return { status: "ok", data: JSON.stringify(restPulls) };
  const q = req.endpoint === "graphql" ? (JSON.parse(req.body!) as { query: string }).query : "";
  if (/addPullRequestReview\s*\(/.test(q))
    return {
      status: "ok",
      data: JSON.stringify({
        data: {
          addPullRequestReview: { pullRequestReview: { id: "PRR1", state: "PENDING", comments: { totalCount: 1 } } },
        },
      }),
    };
  if (/addPullRequestReviewThread\s*\(/.test(q))
    return {
      status: "ok",
      data: JSON.stringify({ data: { addPullRequestReviewThread: { thread: thread("T-new", 4) } } }),
    };
  return { status: "error", error: { kind: "other", message: "not stubbed" } };
}

const notify = vi.fn();
let views: EditorView[] = [];
let deactivate: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  ghApi.mockReset();
  ghApi.mockImplementation((req: { endpoint: string; body?: string }) => Promise.resolve(respond(req)));
  checkout.mockReset();
  notify.mockReset();
  provideNotificationService({ notify } as unknown as NotificationService);
  restPulls = [{ number: N }];
  mergeBase = "head";
  diffHunks = () => [];
  for (const k of Object.keys(config)) delete config[k];
  setCurrentRepository({ owner: "o", name: "r", id: "R1" });
  useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p"],
    repo: "/p",
    branch: { head: "feature", headCommit: "head", upstream: "origin/feature", ahead: 0, behind: 0, operation: null },
  });
  useGhRepository.setState({
    connection: {
      coordinates: { owner: "o", name: "r" },
      repository: { id: "R1", viewerPermission: "READ" } as GHRepository,
      currentUser: me,
    },
  });
  useReviewModeSettings.setState({ enabled: true, threads: "unresolved" });
  setPullRequestData(
    N,
    "details",
    () => ({ id: "PR1", number: N, headRefOid: "head", baseRefOid: "base" }) as GHPullRequest,
  );
  setPullRequestData(N, "changes", () => [file]);
  setPullRequestData(N, "pendingReview", () => null);
  setPullRequestData(N, "threads", () => [thread("T1", 3), thread("T2", 5, { isResolved: true })]);
});

afterEach(async () => {
  deactivate?.();
  deactivate = null;
  for (const v of views) v.destroy();
  views = [];
  cleanup();
  // React roots of the inlays and the toolbar unmount in a microtask.
  await new Promise((r) => setTimeout(r, 0));
  clearNewComments();
  clearPullRequests();
  useEditorRegistry.setState({ active: null });
  useReviewBranch.setState({ number: null, branch: null, updateRequired: false });
  useGhRepository.setState({ connection: null });
  useVcs.setState({ available: false, branch: null, repo: null, roots: [], root: null });
});

describe("the pull request of the current branch", () => {
  it("finds the open pull request whose head the branch tracks and checks the sync state", async () => {
    config["branch.feature.remote"] = "fork";
    config["branch.feature.merge"] = "refs/heads/feature";
    await refreshCurrentBranchPullRequest();
    expect(useReviewBranch.getState()).toEqual({ number: N, branch: "feature", updateRequired: false });
    expect(calls(/pulls\?/)).toEqual([
      expect.objectContaining({
        method: "GET",
        endpoint: "repos/o/r/pulls?state=open&head=alice%3Afeature&per_page=1",
      }),
    ]);
  });

  it("requires an update when the head commit is not in the local history", async () => {
    config["branch.feature.remote"] = "origin";
    config["branch.feature.merge"] = "refs/heads/feature";
    mergeBase = null;
    await refreshCurrentBranchPullRequest();
    expect(useReviewBranch.getState()).toMatchObject({ number: N, updateRequired: true });
  });

  it("finds nothing without an upstream or an open pull request", async () => {
    await refreshCurrentBranchPullRequest();
    expect(useReviewBranch.getState().number).toBeNull();
    config["branch.feature.remote"] = "origin";
    config["branch.feature.merge"] = "refs/heads/feature";
    restPulls = [];
    await refreshCurrentBranchPullRequest();
    expect(useReviewBranch.getState().number).toBeNull();
  });

  it("shows the pull request in the branch widget and adds its popup actions", async () => {
    config["branch.feature.remote"] = "origin";
    config["branch.feature.merge"] = "refs/heads/feature";
    deactivate = activateReviewMode();
    await waitFor(() => expect(useReviewBranch.getState().number).toBe(N));
    const ext = () => useBranchWidgetExtensions.getState().extensions.get("github.pullRequest");
    await waitFor(() => expect(ext()?.presentation?.text).toBe("#12 on feature"));
    expect(ext()!.presentation!.tooltip).toBe("Pull request #12 exists for current branch feature");
    expect(ext()!.actions!.map((a) => [a.label, a.checked])).toEqual([
      ["Show Pull Request in the Tool Window", undefined],
      ["Submit Review…", undefined],
      ["Review Mode", true],
    ]);
    act(() => setReviewModeEnabled(false));
    expect(ext()!.actions![2]!.checked).toBe(false);

    act(() => useReviewBranch.setState({ updateRequired: true }));
    expect(ext()!.presentation).toMatchObject({
      icon: "github-warning",
      tooltip: "Pull request #12 exists for current branch feature, but local branch is out of sync with remote",
    });
    expect(ext()!.actions!.map((a) => a.label)).toContain("Update to Enable Review Mode…");
    deactivate();
    deactivate = null;
    expect(ext()).toBeUndefined();
  });

  it("Update to Enable Review Mode reloads the details, then checks out; a failed reload is reported", async () => {
    useReviewBranch.setState({ number: N, branch: "feature", updateRequired: true });
    // The reload fails (not stubbed).
    await updateReviewBranch();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Pull Request branch update failed" }),
    );
    expect(checkout).not.toHaveBeenCalled();

    ghApi.mockImplementation((req: { endpoint: string; body?: string }) =>
      Promise.resolve(
        req.endpoint === "graphql" && /\.\.\.pullRequestInfo/.test((JSON.parse(req.body!) as { query: string }).query)
          ? {
              status: "ok",
              data: JSON.stringify({
                data: { repository: { pullRequest: { id: "PR1", number: N, headRefOid: "head" } } },
              }),
            }
          : respond(req),
      ),
    );
    await updateReviewBranch();
    expect(checkout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useReviewBranch.getState().updateRequired).toBe(false));
  });
});

// ---------------------------------------------------------------------------

function openEditor(doc: string) {
  const ctx = { doc: 1, path: `/p/${PATH}`, language: "typescript", uiMode: null, readOnly: false };
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [reviewModeEditorExtension(ctx)] }),
    parent: document.body,
  });
  views.push(view);
  useEditorRegistry.setState({ active: { view, ctx } });
  return view;
}

const inlay = (id: string) => document.querySelector<HTMLElement>(`[data-thread-inlay="${id}"]`);
const newCommentBox = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-new-comment]");
    if (!el) throw new Error("no new comment inlay");
    return el;
  });
/** The text of the line an inlay is under (other inlays of the line come between). */
const lineOf = (el: HTMLElement) => {
  let line = el.closest(".cm-lineInlay")!.previousElementSibling;
  while (line?.classList.contains("cm-lineInlay")) line = line.previousElementSibling;
  return line?.textContent;
};

describe("review in the editor", () => {
  beforeEach(() => {
    useReviewBranch.setState({ number: N, branch: "feature", updateRequired: false });
  });

  it("shows the unresolved threads under their lines, following local edits", async () => {
    // Two lines added locally at the top.
    diffHunks = (_a, b) =>
      b.startsWith("new 1\nnew 2\n")
        ? [{ kind: "added", start: 0, lines: 2, oldStart: 0, oldLines: 0, oldText: "" }]
        : [];
    openEditor(`new 1\nnew 2\n${HEAD}`);
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    expect(lineOf(inlay("T1")!)).toBe("line three");
    expect(inlay("T2")).toBeNull();
    // The review's changed line is marked; the gutter offers comments on the hunk's lines.
    expect(document.querySelectorAll(".cm-reviewGutter")).toHaveLength(1);
    act(() => useReviewModeSettings.setState({ threads: "all" }));
    await waitFor(() => expect(inlay("T2")).not.toBeNull());
    expect(lineOf(inlay("T2")!)).toBe("line 5");
  });

  it("puts the Review Mode group in the editor's corner and hides the review when disabled", async () => {
    openEditor(HEAD);
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    const button = document.querySelector<HTMLElement>(".cm-openidea-corner [data-review-mode]")!;
    expect(button.dataset.reviewMode).toBe("on");
    expect(button.dataset.tooltip).toBe(
      "In Review Mode, you can see review comments and proposed changes right in the editor",
    );
    fireEvent.click(button);
    const items = await screen.findAllByRole("menuitemcheckbox").catch(() => screen.findAllByRole("menuitem"));
    expect(items.map((i) => i.textContent)).toEqual([
      "Disable Review Mode",
      "Show Unresolved Comments Only",
      "Show All Comments",
    ]);
    fireEvent.click(screen.getByText("Disable Review Mode"));
    await waitFor(() => expect(inlay("T1")).toBeNull());
    expect(useReviewModeSettings.getState().enabled).toBe(false);
    expect(document.querySelector(".cm-reviewGutter")).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-review-mode]")!.dataset.reviewMode).toBe("off");
  });

  it("offers Update Branch to Enable Review Mode while out of sync", async () => {
    useReviewBranch.setState({ updateRequired: true });
    openEditor(HEAD);
    const button = await waitFor(() => {
      const b = document.querySelector<HTMLElement>("[data-review-mode]");
      if (!b) throw new Error("no toolbar");
      return b;
    });
    expect(button.dataset.reviewMode).toBe("outOfSync");
    expect(inlay("T1")).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText("Update Branch to Enable Review Mode…")).toBeTruthy();
  });

  it("does nothing for files outside the pull request", async () => {
    const ctx = { doc: 2, path: "/p/other.ts", language: "", uiMode: null, readOnly: false };
    const view = new EditorView({
      state: EditorState.create({ doc: HEAD, extensions: [reviewModeEditorExtension(ctx)] }),
      parent: document.body,
    });
    views.push(view);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-review-mode]")).toBeNull();
  });

  it("Add Single Comment posts a comment on the review head's line", async () => {
    diffHunks = (_a, b) =>
      b.startsWith("new 1\n") ? [{ kind: "added", start: 0, lines: 1, oldStart: 0, oldLines: 0, oldText: "" }] : [];
    const view = openEditor(`new 1\n${HEAD}`);
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    // The caret on document line 4 ("line three", head line 2), a commentable line.
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    act(() => activeReviewEditor()!.addComment(false));
    const box = await newCommentBox();
    expect(lineOf(box)).toBe("line three");
    expect(
      within(box)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Add Single Comment", "Start Review"]);
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "why?" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add Single Comment" }));
    await waitFor(() => expect(useNewComments.getState().comments).toHaveLength(0));
    expect(calls(/addPullRequestReview\s*\(/)).toEqual([
      {
        pullRequestId: "PR1",
        commitOid: "head",
        event: "COMMENT",
        threads: [{ body: "why?", path: PATH, line: 3, side: "RIGHT", startLine: null, startSide: null }],
      },
    ]);
  });

  it("Start Review on several lines; lines added locally can't be commented", async () => {
    diffHunks = (_a, b) =>
      b.startsWith("new 1\n") ? [{ kind: "added", start: 0, lines: 1, oldStart: 0, oldLines: 0, oldText: "" }] : [];
    openEditor(`new 1\n${HEAD}`);
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    const editor = activeReviewEditor()!;
    act(() => editor.request({ start: 0, end: 0 }));
    expect(useNewComments.getState().comments).toHaveLength(0);
    act(() => editor.request({ start: 2, end: 4 }));
    const box = await newCommentBox();
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "block" } });
    fireEvent.click(within(box).getByRole("button", { name: "Start Review" }));
    await waitFor(() => expect(calls(/addPullRequestReview\s*\(/)).toHaveLength(1));
    expect(calls(/addPullRequestReview\s*\(/)[0]).toEqual({
      pullRequestId: "PR1",
      commitOid: "head",
      threads: [{ body: "block", path: PATH, line: 4, side: "RIGHT", startLine: 2, startSide: "RIGHT" }],
    });
  });

  it("Add Review Comment adds a thread to the pending review", async () => {
    setPullRequestData(N, "pendingReview", () => ({ id: "PRR0", state: "PENDING", commentsCount: 1 }));
    openEditor(HEAD);
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    act(() => activeReviewEditor()!.request({ start: 0, end: 0 }));
    const box = await newCommentBox();
    expect(
      within(box)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Add Review Comment"]);
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "nit" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add Review Comment" }));
    await waitFor(() =>
      expect(calls(/addPullRequestReviewThread/)).toEqual([
        {
          pullRequestReviewId: "PRR0",
          body: "nit",
          path: PATH,
          line: 1,
          side: "RIGHT",
          startLine: null,
          startSide: null,
        },
      ]),
    );
  });

  it("Next Comment moves the caret to the next visible thread", async () => {
    useReviewModeSettings.setState({ threads: "all" });
    const view = openEditor(HEAD);
    await waitFor(() => expect(inlay("T2")).not.toBeNull());
    const editor = activeReviewEditor()!;
    await act(() => editor.gotoComment(1));
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    await act(() => editor.gotoComment(1));
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    expect(await editor.gotoComment(1)).toBe(false);
  });
});
