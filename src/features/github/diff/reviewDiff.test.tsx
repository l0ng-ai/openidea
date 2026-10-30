import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContextMenuHost } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";

const texts: Record<string, string> = {};
const ghApi = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "error", error: "none" }),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] ?? "" }),
      ghApi: (req: unknown) => ghApi(req),
    },
  };
});

import { DiffEditor } from "@/features/vcs/DiffEditor";
import { setCurrentRepository } from "../api/client";
import type {
  GHCommitFile,
  GHPullRequest,
  GHPullRequestReviewComment,
  GHPullRequestReviewThread,
  GHRepository,
  GHUser,
} from "../api/types";
import { PULL_REQUEST_DIFF } from "../data/local";
import { clearPullRequests, setPullRequestData } from "../data/pullRequest";
import { useGhRepository } from "../data/repository";
import { activateReviewDiff } from ".";
import { clearNewComments, requestNewComment, useNewComments } from "./newComments";
import { newCommentLocation } from "./model";
import { setReviewDiffSettings, useReviewDiffSettings } from "./settings";

const N = 7;
const PATH = "src/a.ts";
const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const HEAD = BASE.replace("line 3\n", "line three\n");
const PATCH = "@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+line three\n line 4\n line 5\n line 6";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };

let commentSeq = 0;
const comment = (body: string, over: Partial<GHPullRequestReviewComment> = {}): GHPullRequestReviewComment =>
  ({
    id: `C${++commentSeq}`,
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
    ...over,
  }) as GHPullRequestReviewComment;

const thread = (id: string, line: number, bodies: string[], over: Partial<GHPullRequestReviewThread> = {}) =>
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
    comments: { nodes: bodies.map((b) => comment(b)) },
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

const input = (commit: string | null = null) =>
  ({
    kind: "diff",
    key: `diff:${commit}`,
    path: `/p/${PATH}`,
    data: {
      path: `/p/${PATH}`,
      left: { type: "rev", rev: commit ? `${commit}^` : "base" },
      right: { type: "rev", rev: commit ?? "head" },
      context: { kind: PULL_REQUEST_DIFF, number: N, path: PATH, commit },
    },
  }) as unknown as EditorInput;

/** The GraphQL / REST calls made, by operation. */
function calls(op: RegExp) {
  return ghApi.mock.calls
    .map(([req]) => req as { endpoint: string; body?: string })
    .filter((r) => op.test(r.endpoint === "graphql" ? (JSON.parse(r.body!) as { query: string }).query : r.endpoint))
    .map((r) =>
      r.endpoint === "graphql" ? (JSON.parse(r.body!) as { variables: Record<string, unknown> }).variables : r,
    );
}

function respond(req: { endpoint: string; body?: string }): string {
  if (req.endpoint.includes("/compare/")) return JSON.stringify({ files: [{ ...file, patch: PATCH }] });
  const q = req.endpoint === "graphql" ? (JSON.parse(req.body!) as { query: string }).query : "";
  const t = thread("T-new", 4, ["new"]);
  if (/addPullRequestReview\s*\(/.test(q))
    return JSON.stringify({
      data: {
        addPullRequestReview: { pullRequestReview: { id: "PRR1", state: "PENDING", comments: { totalCount: 1 } } },
      },
    });
  if (/addPullRequestReviewThread\s*\(/.test(q))
    return JSON.stringify({ data: { addPullRequestReviewThread: { thread: t } } });
  if (/addPullRequestReviewComment\s*\(/.test(q))
    return JSON.stringify({ data: { addPullRequestReviewComment: { comment: comment("c") } } });
  if (/resolveReviewThread\s*\(/.test(q))
    return JSON.stringify({ data: { resolveReviewThread: { thread: { ...t, isResolved: true } } } });
  // Reloads fail: the cached data stays.
  return JSON.stringify({ errors: [{ message: "not stubbed" }] });
}

let deactivate: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  useReviewDiffSettings.setState({ threadsView: "all", reviewCommentsPreferred: true, autoMarkViewed: false });
  texts.base = BASE;
  texts.head = HEAD;
  texts["c1^"] = BASE;
  texts.c1 = HEAD;
  ghApi.mockReset();
  ghApi.mockImplementation((req: { endpoint: string; body?: string }) =>
    Promise.resolve({ status: "ok", data: respond(req) }),
  );
  setCurrentRepository({ owner: "o", name: "r", id: "R1" });
  useGhRepository.setState({
    connection: {
      coordinates: { owner: "o", name: "r" },
      repository: { id: "R1", viewerPermission: "READ" } as GHRepository,
      currentUser: me,
    },
  });
  setPullRequestData(
    N,
    "details",
    () => ({ id: "PR1", number: N, headRefOid: "head", baseRefOid: "base" }) as GHPullRequest,
  );
  setPullRequestData(N, "changes", () => [file]);
  setPullRequestData(N, "viewedState", () => ({ [PATH]: "UNVIEWED" }));
  setPullRequestData(N, "pendingReview", () => null);
  setPullRequestData(N, "threads", () => [
    thread("T1", 3, ["first", "second", "third", "fourth"]),
    thread("T2", 5, ["done"], { isResolved: true }),
  ]);
  deactivate = activateReviewDiff();
});

afterEach(() => {
  cleanup();
  deactivate();
  clearNewComments();
  clearPullRequests();
  useGhRepository.setState({ connection: null });
});

const view = (commit: string | null = null) =>
  render(
    <>
      <DiffEditor input={input(commit)} />
      <ContextMenuHost />
    </>,
  );

/** The new comment's inlay, once shown. */
const newCommentBox = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-new-comment]");
    if (!el) throw new Error("no new comment inlay");
    return el;
  });

const inlay = (id: string) => document.querySelector<HTMLElement>(`[data-thread-inlay="${id}"]`);

describe("review threads in a pull request diff", () => {
  it("shows threads as compact inlays under their lines, filtered by Show Review Threads", async () => {
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    const t1 = inlay("T1")!;
    // More than 3 comments: the first, "… 2 more replies", the last.
    expect(t1.textContent).toContain("first");
    expect(t1.textContent).toContain("2 more replies");
    expect(t1.textContent).not.toContain("second");
    expect(t1.textContent).toContain("fourth");
    // Under line 3 of the right side.
    const right = document.querySelector(".cm-merge-b")!;
    expect(right.contains(t1)).toBe(true);
    expect(t1.closest(".cm-lineInlay")!.previousElementSibling?.textContent).toBe("line three");
    expect(right.querySelectorAll(".cm-reviewControl-toggle")).toHaveLength(2);
    expect(inlay("T2")).not.toBeNull();

    act(() => setReviewDiffSettings({ threadsView: "unresolved" }));
    await waitFor(() => expect(inlay("T2")).toBeNull());
    expect(inlay("T1")).not.toBeNull();
    act(() => setReviewDiffSettings({ threadsView: "none" }));
    await waitFor(() => expect(inlay("T1")).toBeNull());
  });

  it("follows the threads when the data reloads", async () => {
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    act(() => setPullRequestData(N, "threads", () => [thread("T9", 1, ["fresh"])]));
    await waitFor(() => expect(inlay("T9")).not.toBeNull());
    expect(inlay("T1")).toBeNull();
  });

  it("replies to and resolves a thread", async () => {
    setPullRequestData(N, "pendingReview", () => ({ id: "PRR0", state: "PENDING", commentsCount: 0 }));
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    const t1 = within(inlay("T1")!);
    fireEvent.click(t1.getByRole("button", { name: "Reply" }));
    fireEvent.change(t1.getByRole("textbox"), { target: { value: "thanks" } });
    const replies = t1.getAllByRole("button", { name: "Reply" });
    fireEvent.click(replies[replies.length - 1]!);
    await waitFor(() =>
      expect(calls(/addPullRequestReviewComment/)).toEqual([
        expect.objectContaining({ reviewId: "PRR0", body: "thanks", inReplyTo: expect.stringMatching(/^C/) }),
      ]),
    );
    fireEvent.click(within(inlay("T1")!).getAllByRole("button", { name: "Resolve" })[0]!);
    await waitFor(() => expect(calls(/resolveReviewThread/)).toEqual([{ threadId: "T1" }]));
  });
});

describe("new comments", () => {
  it("Start Review creates a pending review with the comment's thread and becomes the preferred action", async () => {
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    act(() => void requestNewComment(N, PATH, null, newCommentLocation("right", 1, 3)));
    const box = await newCommentBox();
    // Without a pending review: Add Single Comment, then the preferred Start Review (primary).
    const buttons = within(box).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Add Single Comment", "Start Review"]);
    // The range is outlined; on the changes it can be adjusted.
    expect(document.querySelectorAll(".cm-merge-b .cm-reviewRange")).toHaveLength(3);
    expect(document.querySelector<HTMLElement>(".cm-reviewHandle")?.title).toBe(
      "Drag to select several lines for commenting",
    );
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Looks odd" } });
    fireEvent.click(within(box).getByRole("button", { name: "Start Review" }));
    await waitFor(() => expect(useNewComments.getState().comments).toHaveLength(0));
    expect(calls(/addPullRequestReview\s*\(/)).toEqual([
      {
        pullRequestId: "PR1",
        commitOid: "head",
        threads: [{ body: "Looks odd", path: PATH, line: 4, side: "RIGHT", startLine: 2, startSide: "RIGHT" }],
      },
    ]);
    expect(useReviewDiffSettings.getState().reviewCommentsPreferred).toBe(true);
  });

  it("Add Single Comment posts the comment at once and becomes the primary button", async () => {
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    act(() => void requestNewComment(N, PATH, null, newCommentLocation("left", 4, 4)));
    const box = await newCommentBox();
    // A left-side comment goes into the left pane.
    expect(document.querySelector(".cm-merge-a")!.contains(box)).toBe(true);
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "hm" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add Single Comment" }));
    await waitFor(() => expect(calls(/addPullRequestReview\s*\(/)).toHaveLength(1));
    expect(calls(/addPullRequestReview\s*\(/)[0]).toMatchObject({
      event: "COMMENT",
      threads: [{ body: "hm", path: PATH, line: 5, side: "LEFT", startLine: null, startSide: null }],
    });
    await waitFor(() => expect(useReviewDiffSettings.getState().reviewCommentsPreferred).toBe(false));
  });

  it("Add Review Comment adds a thread to the pending review", async () => {
    setPullRequestData(N, "pendingReview", () => ({ id: "PRR0", state: "PENDING", commentsCount: 2 }));
    view();
    await screen.findByRole("button", { name: "Submit Review (2)…" });
    act(() => void requestNewComment(N, PATH, null, newCommentLocation("right", 0, 0)));
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

  it("comments on a single commit's diff at the line's diff position, with a fixed range", async () => {
    setPullRequestData(N, "pendingReview", () => ({ id: "PRR0", state: "PENDING", commentsCount: 0 }));
    view("c1");
    await waitFor(() => expect(inlay("T1")).toBeNull());
    act(() => void requestNewComment(N, PATH, "c1", newCommentLocation("right", 2, 2)));
    const box = await newCommentBox();
    expect(document.querySelector<HTMLElement>(".cm-reviewHandle")?.title).toBe(
      "Comment range cannot be adjusted while reviewing a single commit",
    );
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "here" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add Review Comment" }));
    await waitFor(() =>
      expect(calls(/addPullRequestReviewComment/)).toEqual([
        { reviewId: "PRR0", body: "here", commit: "c1", file: PATH, position: 4 },
      ]),
    );
    expect(calls(/compare\/base\.\.\.c1/)).toHaveLength(1);
  });

  it("discards an empty new comment on Escape", async () => {
    view();
    act(() => void requestNewComment(N, PATH, null, newCommentLocation("right", 1, 1)));
    const box = await newCommentBox();
    fireEvent.keyDown(within(box).getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-new-comment]")).toBeNull());
  });
});

describe("viewed state", () => {
  it("marks the file viewed from the editor menu", async () => {
    view();
    await waitFor(() => expect(inlay("T1")).not.toBeNull());
    const line = [...document.querySelectorAll(".cm-merge-b .cm-line")].find((l) => l.textContent === "line 2")!;
    fireEvent.contextMenu(line, { clientX: 5, clientY: 5 });
    const item = await screen.findByRole("menuitem", { name: /Mark File as Viewed/ });
    expect(screen.getByRole("menuitem", { name: "Add Review Comment" })).toBeTruthy();
    fireEvent.click(item);
    await waitFor(() => expect(calls(/markFileAsViewed/)).toEqual([{ pullRequestId: "PR1", path: PATH }]));
  });

  it("marks opened files viewed when Automatically mark opened files as viewed is on", async () => {
    useReviewDiffSettings.setState({ autoMarkViewed: true });
    view();
    await waitFor(() => expect(calls(/markFileAsViewed/)).toEqual([{ pullRequestId: "PR1", path: PATH }]));
  });

  it("does not mark a single commit's file viewed", async () => {
    useReviewDiffSettings.setState({ autoMarkViewed: true });
    view("c1");
    await screen.findByRole("button", { name: "Submit Review…" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls(/markFileAsViewed/)).toEqual([]);
  });
});
