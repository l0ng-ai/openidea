import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as ipc from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContextMenuStore, type MenuItem } from "@/ui";
import { setCurrentRepository } from "../api/client";
import type { GHPullRequestShort, GHRepository, GHUser } from "../api/types";
import { clearList, useGhPrList } from "../data/list";
import { useGhRepository } from "../data/repository";
import { loadLastSearch, loadSearchHistory } from "../data/searchHistory";
import { resetTabs, useGhTabs } from "../toolwindow/store";
import { ListPanel } from "./ListPanel";
import {
  createSearchHistoryRecorder,
  infoLine,
  isQuickFilterSelected,
  pastThreshold,
  quickFilters,
  rowReviewers,
  searchHistoryText,
  unresolvedCommentsTooltip,
  withQuery,
} from "./model";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };
const user = (login: string, name: string | null = null): GHUser => ({
  __typename: "User",
  id: `id-${login}`,
  login,
  url: "",
  avatarUrl: "",
  name,
});
const nodes = <T,>(n: T[]) => ({ nodes: n });

function pr(number: number, over: Partial<GHPullRequestShort> = {}): GHPullRequestShort {
  return {
    id: `PR${number}`,
    url: `https://github.com/org/app/pull/${number}`,
    number,
    title: `Pull request ${number}`,
    state: "OPEN",
    isDraft: false,
    author: user("ann"),
    createdAt: "2020-01-02T10:00:00Z",
    updatedAt: "2020-01-02T10:00:00Z",
    isReadByViewer: true,
    assignees: nodes([]),
    labels: nodes([]),
    reviewRequests: nodes([]),
    reviewThreads: nodes([]),
    reviews: nodes([]),
    reactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } as never,
    mergeable: "MERGEABLE",
    viewerCanUpdate: false,
    viewerCanReact: false,
    viewerDidAuthor: false,
    ...over,
  };
}

describe("search model", () => {
  it("offers IntelliJ's quick filters, checked only on an exact match", () => {
    const q = quickFilters("me");
    expect(q.map((f) => f.title)).toEqual(["Open", "Your pull requests", "Assigned to you", "Review requests"]);
    expect(q[1]!.filter).toEqual({ state: "OPEN", author: "me" });
    expect(q[3]!.filter).toEqual({ state: "OPEN", reviewState: "AWAITING_REVIEW" });
    expect(isQuickFilterSelected({ state: "OPEN", assignee: "me" }, q[2]!)).toBe(true);
    expect(isQuickFilterSelected({ state: "OPEN", assignee: "me", sort: "NEWEST" }, q[2]!)).toBe(false);
  });

  it("writes the history text like getShortText", () => {
    expect(
      searchHistoryText({
        searchQuery: "foo",
        state: "OPEN",
        label: "bug",
        assignee: "me",
        reviewState: "AWAITING_REVIEW",
        author: "x",
        sort: "NEWEST",
      }),
    ).toBe('"foo" state:"Open" label:bug assignee:me reviewState:"Awaiting review" author:x sort:"Newest"');
    expect(searchHistoryText({ reviewState: "REVIEWED_BY_ME" })).toBe('reviewState:"Reviewed"');
  });

  it("sets or clears the text", () => {
    expect(withQuery({ state: "OPEN" }, "fix")).toEqual({ state: "OPEN", searchQuery: "fix" });
    expect(withQuery({ state: "OPEN", searchQuery: "fix" }, "")).toEqual({ state: "OPEN" });
  });

  it("saves searches by IntelliJ's rules, waiting 10 seconds for chip-only changes", () => {
    vi.useFakeTimers();
    try {
      const saveLast = vi.fn();
      const remember = vi.fn();
      const r = createSearchHistoryRecorder({ defaultSearch: { state: "OPEN", assignee: "me" }, saveLast, remember });
      r.onChange({ state: "OPEN", assignee: "me" });
      expect(saveLast).toHaveBeenCalledTimes(1);
      r.onChange({ state: "OPEN", searchQuery: "a" });
      expect(remember).toHaveBeenLastCalledWith({ state: "OPEN", searchQuery: "a" });
      r.onChange({ state: "CLOSED", searchQuery: "a" });
      vi.advanceTimersByTime(5_000);
      r.onChange({ state: "MERGED", searchQuery: "a" });
      vi.advanceTimersByTime(9_999);
      expect(remember).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(remember).toHaveBeenLastCalledWith({ state: "MERGED", searchQuery: "a" });
      r.onChange({});
      r.onChange({ state: "OPEN", assignee: "me" });
      vi.advanceTimersByTime(20_000);
      expect(remember).toHaveBeenCalledTimes(2);
      expect(saveLast).toHaveBeenCalledTimes(6);
      r.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("row model", () => {
  it("orders reviewers approved → changes requested → commented → re-requested → needs review", () => {
    const review = (author: GHUser, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", at: number) =>
      ({
        __typename: "PullRequestReview",
        id: `${author.login}${at}`,
        url: "",
        author,
        body: "",
        state,
        createdAt: new Date(at * 1000).toISOString(),
        viewerCanUpdate: false,
      }) as const;
    const p = pr(1, {
      reviews: nodes([
        review(user("c"), "COMMENTED", 1),
        review(user("a", "Ada"), "APPROVED", 2),
        review(user("r"), "COMMENTED", 3),
        review(user("x"), "CHANGES_REQUESTED", 4),
      ]),
      reviewRequests: nodes([{ requestedReviewer: user("n") }, { requestedReviewer: user("r") }]),
    });
    expect(rowReviewers(p).map((r) => [r.name, r.state])).toEqual([
      ["Ada", "APPROVED"],
      ["x", "CHANGES_REQUESTED"],
      ["c", "COMMENTED"],
      ["r", "RE_REQUESTED"],
      ["n", "NEEDS_REVIEW"],
    ]);
  });

  it("formats the info line and the comment tooltip", () => {
    expect(infoLine(12, "Today", "ann")).toBe("#12 · created Today, by ann");
    expect(infoLine(12, "Today", null)).toBe("#12 · created Today");
    expect(unresolvedCommentsTooltip(0)).toBe("No unresolved comments");
    expect(unresolvedCommentsTooltip(1)).toBe("1 unresolved comment");
    expect(unresolvedCommentsTooltip(3)).toBe("3 unresolved comments");
  });

  it("requests the next page past 70% of the scroll", () => {
    expect(pastThreshold(0, 300, 1000)).toBe(false);
    expect(pastThreshold(400, 300, 1000)).toBe(true);
    expect(pastThreshold(0, 300, 200)).toBe(true);
  });
});

const repository: GHRepository = {
  id: "R1",
  owner: { __typename: "User", id: "O1", login: "org" },
  nameWithOwner: "org/app",
  viewerPermission: "READ",
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  defaultBranchRef: { name: "main" },
  isFork: false,
  url: "https://github.com/org/app",
  sshUrl: "",
};

describe("ListPanel", () => {
  let pages: GHPullRequestShort[][] = [];
  let queries: string[] = [];
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    queries = [];
    vi.spyOn(ipc.commands, "ghApi").mockImplementation(async (req) => {
      const body = JSON.parse(req.body!) as { variables: { query: string } };
      queries.push(body.variables.query);
      const page = pages.shift() ?? [];
      return {
        status: "ok",
        data: JSON.stringify({
          data: {
            search: {
              pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
              nodes: page,
            },
          },
        }),
      } as never;
    });
    setCurrentRepository({ owner: "org", name: "app", id: "R1" });
    useGhRepository.setState({
      availability: { kind: "ready", repo: {} as never, login: "me" },
      remotes: [{ owner: "org", name: "app", remote: "origin", url: "" }],
      connection: { coordinates: { owner: "org", name: "app" }, repository, currentUser: me },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearList();
    useGhPrList.setState({ search: {} });
    useGhRepository.setState({ connection: null, availability: null, remotes: [] });
    setCurrentRepository(null);
    resetTabs();
    useContextMenuStore.setState({ menu: null });
  });

  const mount = async () => {
    await act(async () => {
      render(<ListPanel />);
    });
  };

  it("starts with Assigned to you and renders the rows", async () => {
    pages = [
      [
        pr(7, {
          title: "Fix the thing",
          isDraft: true,
          mergeable: "CONFLICTING",
          author: me,
          labels: nodes([{ id: "L", url: "", name: "bug", color: "ff0000" }]),
          reviewThreads: nodes([
            { isResolved: false, isOutdated: false },
            { isResolved: true, isOutdated: false },
            { isResolved: false, isOutdated: true },
          ]),
          assignees: nodes([user("a"), user("b"), user("c")]),
        }),
        pr(8, { state: "MERGED", author: null }),
      ],
    ];
    await mount();
    expect(queries[0]).toBe("type:pr repo:org/app is:open assignee:me");
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText("Fix the thing")).toBeTruthy();
    expect(first.getByText("DRAFT")).toBeTruthy();
    expect(rows[0]!.querySelector("[data-tooltip='Pull request cannot be merged']")).toBeTruthy();
    expect(rows[0]!.querySelector("[data-tooltip='1 unresolved comment']")?.textContent).toBe("1");
    expect(rows[0]!.querySelectorAll("[data-avatar]")).toHaveLength(2);
    // Authored by me, never seen: unread.
    expect(rows[0]!.querySelector("[data-unread]")).toBeTruthy();
    expect(first.getByText(/^#7 · created .+, by me$/)).toBeTruthy();
    expect(within(rows[1]!).getByText("MERGED")).toBeTruthy();
    expect(within(rows[1]!).getByText(/^#8 · created /).textContent).not.toContain(", by");
    expect(rows[1]!.querySelector("[data-unread]")).toBeNull();
    expect(loadLastSearch()).toEqual({ state: "OPEN", assignee: "me" });
  });

  it("opens the context menu with IntelliJ's items on the clicked row", async () => {
    pages = [[pr(1), pr(2)]];
    await mount();
    fireEvent.contextMenu(screen.getAllByRole("option")[1]!);
    expect(useGhTabs.getState().listSelection).toBe(2);
    const items = useContextMenuStore.getState().menu!.items;
    expect(items.map((i: MenuItem) => ("action" in i ? i.action : i.kind))).toEqual([
      "github.pullRequest.show",
      "github.pullRequest.checkoutBranch",
      "github.pullRequest.openInWorktree",
      "github.pullRequest.openInBrowser",
      "github.pullRequest.copyUrl",
      "separator",
      "github.refresh",
    ]);
  });

  it("shows the empty states and clears filters", async () => {
    pages = [[], []];
    await mount();
    expect(screen.getByText("No pull requests matching filters")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Clear filters")));
    expect(queries[1]).toBe("type:pr repo:org/app");
    expect(screen.getByText("No pull requests in app")).toBeTruthy();
  });

  it("shows load errors with Retry", async () => {
    vi.mocked(ipc.commands.ghApi).mockRejectedValueOnce(new Error("HTTP 502"));
    await mount();
    expect(screen.getByText("Can't load pull requests")).toBeTruthy();
    pages = [[pr(3)]];
    await act(async () => fireEvent.click(screen.getByText("Retry")));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("applies the text on Enter and keeps it in the history", async () => {
    pages = [[], []];
    await mount();
    const field = screen.getByRole("textbox", { name: "Search pull requests" });
    fireEvent.change(field, { target: { value: "crash" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(queries[1]).toBe("type:pr repo:org/app crash is:open assignee:me");
    expect(loadSearchHistory()).toEqual([{ state: "OPEN", assignee: "me", searchQuery: "crash" }]);
  });

  it("resets a chip with its ✕ and with Delete, and shows the quick filter badge", async () => {
    pages = [[], [], []];
    await mount();
    expect(document.querySelector("[data-badge]")).toBeTruthy();
    const assignee = screen.getByText("me").closest("button")!;
    await act(async () => fireEvent.keyDown(assignee, { key: "Delete" }));
    expect(queries[1]).toBe("type:pr repo:org/app is:open");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset State" })));
    expect(queries[2]).toBe("type:pr repo:org/app");
    expect(document.querySelector("[data-badge]")).toBeNull();
    expect(screen.getByText("State")).toBeTruthy();
  });

  it("chooses a chip value from its popup", async () => {
    pages = [[], []];
    await mount();
    await act(async () => fireEvent.click(screen.getByText("Sort")));
    await act(async () => fireEvent.click(screen.getByText("Least recently updated")));
    expect(queries[1]).toBe("type:pr repo:org/app is:open assignee:me sort:updated-asc");
  });
});
