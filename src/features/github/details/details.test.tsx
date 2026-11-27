import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import * as api from "../api/requests";
import type {
  GHPRMergeabilityState,
  GHPullRequest,
  GHPullRequestPendingReview,
  GHRepository,
  GHUser,
} from "../api/types";
import { reviewersStates } from "../data/model";
import { submitOrCreateReview } from "../data/operations";
import { clearPullRequests, setPullRequestData } from "../data/pullRequest";
import { useGhRepository } from "../data/repository";
import { GithubDialogHost } from "../ui/dialogs";
import { ReviewActions } from "./ReviewActions";
import { useReviewText } from "./state";
import { StatusSection } from "./StatusSection";
import { showSubmitReview } from "./SubmitReviewPopup";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };
const bob: GHUser = { __typename: "User", id: "U2", login: "bob", url: "", avatarUrl: "", name: "Bob" };
const repository: GHRepository = {
  id: "R1",
  owner: { __typename: "User", id: "O1", login: "org" },
  nameWithOwner: "org/app",
  viewerPermission: "WRITE",
  mergeCommitAllowed: false,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  defaultBranchRef: { name: "main" },
  isFork: false,
  url: "https://github.com/org/app",
  sshUrl: "",
};
const mergeability: GHPRMergeabilityState = {
  hasConflicts: true,
  ciJobs: [{ name: "build", status: "PENDING", isRequired: true, detailsUrl: null }],
  canBeMerged: true,
  canBeRebased: true,
  isRestricted: false,
  requiredApprovingReviewsCount: 1,
  checksState: null,
  mergeable: "CONFLICTING",
  mergeStateStatus: "BLOCKED",
};

function pr(patch: Partial<GHPullRequest> = {}): GHPullRequest {
  return {
    id: "PR1",
    url: "https://github.com/org/app/pull/7",
    number: 7,
    title: "Title",
    state: "OPEN",
    isDraft: false,
    author: me,
    createdAt: "",
    updatedAt: "",
    isReadByViewer: true,
    assignees: { nodes: [] },
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    mergeable: "MERGEABLE",
    viewerCanUpdate: true,
    viewerCanReact: true,
    viewerDidAuthor: true,
    reactions: {
      pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
      nodes: [],
    },
    body: "",
    reviewDecision: null,
    baseRefName: "main",
    baseRefOid: "base",
    baseRepository: repository,
    headRef: { id: "ref" },
    headRefName: "feature",
    headRefOid: "head",
    headRepository: repository,
    viewerCanDeleteHeadRef: false,
    ...patch,
  };
}

beforeEach(() => {
  useGhRepository.setState({
    connection: { coordinates: { owner: "org", name: "app" }, repository, currentUser: me, root: null, remotes: [] },
  });
  setPullRequestData(7, "pendingReview", () => null);
});
afterEach(() => {
  cleanup();
  clearPullRequests();
  useGhRepository.setState({ connection: null });
});

describe("StatusSection", () => {
  it("shows the loading line until the mergeability loads", () => {
    render(
      <StatusSection
        pr={pr()}
        mergeability={undefined}
        reviewers={[]}
        canManage
        busy={false}
        resolve={{ error: "Details have not finished loading" }}
        onResolve={() => {}}
        permission="WRITE"
      />,
    );
    expect(screen.getByText("Loading pull request status")).toBeTruthy();
  });

  it("lists checks, conflicts, required reviews and reviewers", () => {
    const p = pr({ reviewRequests: { nodes: [{ requestedReviewer: bob }] } });
    render(
      <StatusSection
        pr={p}
        mergeability={mergeability}
        reviewers={reviewersStates(p)}
        canManage
        busy={false}
        resolve={{ error: "Merge is already in progress" }}
        onResolve={() => {}}
        permission="READ"
      />,
    );
    expect(screen.queryByText("Repository write access required to merge pull requests")).toBeTruthy();
    expect(screen.getByText("Checks in progress…")).toBeTruthy();
    expect(screen.getByText("Details…")).toBeTruthy();
    expect(screen.getByText("Branch has conflicts that must be resolved")).toBeTruthy();
    expect((screen.getByText("Resolve").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("At least 1 approving review is required by reviewers with write access")).toBeTruthy();
    expect(screen.getByText("Waiting for review from Bob")).toBeTruthy();
    expect(screen.queryByText("Missing reviewer")).toBeNull();
  });
});

describe("ReviewActions", () => {
  const actions = (p: GHPullRequest, state: "ACCEPTED" | "NEED_REVIEW" = "NEED_REVIEW") =>
    render(
      <ReviewActions
        pr={p}
        mergeability={{ ...mergeability, hasConflicts: false }}
        reviewers={reviewersStates(p)}
        reviewState={state}
        submitRef={createRef()}
      />,
    );

  it("offers Reopen, Post and nothing for closed, draft and merged pull requests", () => {
    actions(pr({ state: "CLOSED" }));
    expect(screen.getByText("Reopen Pull Request")).toBeTruthy();
    cleanup();
    actions(pr({ isDraft: true }));
    expect(screen.getByText("Post Pull Request")).toBeTruthy();
    cleanup();
    const { container } = actions(pr({ state: "MERGED" }));
    expect(container.textContent).toBe("");
  });

  it("shows the author's Request Review… and, once accepted, the merge button", () => {
    actions(pr());
    expect(screen.getByText("Request Review…")).toBeTruthy();
    expect(screen.queryByText("Squash and Merge…")).toBeNull();
    cleanup();
    actions(pr(), "ACCEPTED");
    expect(screen.queryByText("Request Review…")).toBeNull();
    // Merge commits are not allowed in this repository: squash is the main action.
    expect(screen.getByText("Squash and Merge…")).toBeTruthy();
  });

  it("shows Submit Review… to reviewers and Set Myself as Reviewer to guests", () => {
    const asReviewer = pr({
      author: bob,
      viewerDidAuthor: false,
      reviewRequests: { nodes: [{ requestedReviewer: me }] },
    });
    actions(asReviewer);
    expect(screen.getByText("Submit Review…")).toBeTruthy();
    cleanup();
    actions(pr({ author: bob, viewerDidAuthor: false }));
    expect(screen.getByText("Set Myself as Reviewer")).toBeTruthy();
  });
});

describe("Submit Review draft", () => {
  const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Review comment" });
  const close = () => fireEvent.click(screen.getByRole("button", { name: "Close" }));

  function open(number: number) {
    act(() => {
      setPullRequestData(number, "details", () => pr({ number }));
      setPullRequestData(number, "pendingReview", () => null);
      void showSubmitReview(number);
    });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    useReviewText.setState({ text: {} });
  });

  it("restores the draft only for the same repository, account and pull request", () => {
    const connection = useGhRepository.getState().connection!;
    render(<GithubDialogHost />);

    open(7);
    fireEvent.change(editor(), { target: { value: "Draft for org/app #7" } });
    close();

    open(8);
    expect(editor().value).toBe("");
    close();

    act(() => {
      useGhRepository.setState({
        connection: {
          ...connection,
          coordinates: { owner: "org", name: "other" },
          repository: { ...repository, id: "R2", nameWithOwner: "org/other" },
        },
      });
    });
    open(7);
    const otherRepositoryDraft = editor().value;
    close();

    act(() => useGhRepository.setState({ connection: { ...connection, currentUser: bob } }));
    open(7);
    const otherAccountDraft = editor().value;
    close();

    act(() => useGhRepository.setState({ connection }));
    open(7);
    const restoredDraft = editor().value;
    close();

    expect(otherRepositoryDraft).toBe("");
    expect(otherAccountDraft).toBe("");
    expect(restoredDraft).toBe("Draft for org/app #7");
  });

  it("closes an open review popup when its account changes", () => {
    const connection = useGhRepository.getState().connection!;
    render(<GithubDialogHost />);
    open(7);
    fireEvent.change(editor(), { target: { value: "Draft for me" } });

    act(() => useGhRepository.setState({ connection: { ...connection, currentUser: bob } }));
    const remainingEditor = screen.queryByRole("textbox", { name: "Review comment" });
    if (remainingEditor) close();
    expect(remainingEditor).toBeNull();
  });

  it("cancels submission if the account changes during the pull request lookup", async () => {
    const connection = useGhRepository.getState().connection!;
    const lookup = deferred<string>();
    const findPullRequestId = vi.spyOn(api, "findPullRequestId").mockReturnValue(lookup.promise);
    const createReview = vi.spyOn(api, "createReview").mockRejectedValue(new Error("Unexpected review mutation"));

    const submission = submitOrCreateReview(7, "COMMENT", "Draft for me", connection);
    await vi.waitFor(() => expect(findPullRequestId).toHaveBeenCalledWith(7));
    useGhRepository.setState({ connection: { ...connection, currentUser: bob } });
    lookup.resolve("PR1");

    await expect(submission).resolves.toBe(false);
    expect(createReview).not.toHaveBeenCalled();
  });

  it("cancels submission if the connection closes during the pending review lookup", async () => {
    const connection = useGhRepository.getState().connection!;
    setPullRequestData(8, "details", () => pr({ number: 8 }));
    const lookup = deferred<GHPullRequestPendingReview>();
    const findPendingReview = vi.spyOn(api, "findPendingReview").mockReturnValue(lookup.promise);
    const submitReview = vi.spyOn(api, "submitReview").mockRejectedValue(new Error("Unexpected review mutation"));

    const submission = submitOrCreateReview(8, "COMMENT", "Draft for me", connection);
    await vi.waitFor(() => expect(findPendingReview).toHaveBeenCalledWith("PR1"));
    useGhRepository.setState({ connection: null });
    lookup.resolve({ id: "review-1", commentsCount: 0, state: "PENDING" });

    await expect(submission).resolves.toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
  });
});
