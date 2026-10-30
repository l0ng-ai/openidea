import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import * as ipc from "@/platform/ipc";
import { useContributions } from "@/workbench/contributions";
import { activate } from "../index";
import { setCurrentRepository } from "../api/client";
import type { GHRepository, GHUser } from "../api/types";
import { useGhRepository } from "../data/repository";
import { PullRequestsTabs, PullRequestsToolWindow } from "./PullRequestsToolWindow";
import {
  closeTab,
  contextPullRequest,
  openCreateTab,
  openPullRequestTab,
  resetTabs,
  setListSelection,
  useGhTabs,
} from "./store";
import { TIMELINE_KIND, timelineData, timelineInput } from "./timelineInput";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };
const repository: GHRepository = {
  id: "R1",
  owner: { __typename: "User", id: "O1", login: "org" },
  nameWithOwner: "org/app",
  viewerPermission: "WRITE",
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  defaultBranchRef: { name: "main" },
  isFork: false,
  url: "https://github.com/org/app",
  sshUrl: "",
};

describe("tabs", () => {
  beforeEach(() => resetTabs());

  it("opens each pull request once and closes back to the previous tab", () => {
    openPullRequestTab(5);
    openPullRequestTab(7);
    openPullRequestTab(5);
    expect(useGhTabs.getState().tabs).toEqual([
      { kind: "pr", number: 5 },
      { kind: "pr", number: 7 },
    ]);
    expect(useGhTabs.getState().active).toBe("pr:5");
    expect(getContext().githubPrTab).toBe("pr");
    openCreateTab();
    openCreateTab();
    expect(useGhTabs.getState().tabs).toHaveLength(3);
    closeTab("create");
    expect(useGhTabs.getState().active).toBe("pr:7");
    closeTab("list");
    expect(useGhTabs.getState().tabs).toHaveLength(2);
  });

  it("targets the active pull request tab, else the list selection", () => {
    setListSelection(3);
    expect(contextPullRequest()).toBe(3);
    openPullRequestTab(9);
    expect(contextPullRequest()).toBe(9);
    closeTab("pr:9");
    expect(useGhTabs.getState().active).toBe("list");
    expect(contextPullRequest()).toBe(3);
  });

  it("keys timeline tabs by repository and number", () => {
    const input = timelineInput({ owner: "org", name: "app" }, 12);
    expect(input.kind).toBe(TIMELINE_KIND);
    expect(timelineData(input)).toEqual({ owner: "org", name: "app", number: 12 });
    expect(timelineData({ kind: "file", key: "x" })).toBeNull();
  });
});

describe("tool window", () => {
  let dispose: () => void = () => {};
  beforeEach(() => {
    dispose = activate();
  });
  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
    setCurrentRepository(null);
    useGhRepository.setState({ connection: null, availability: null, remotes: [] });
    resetTabs();
  });

  it("registers the window, the timeline editor and the actions", () => {
    const c = useContributions.getState();
    expect(c.toolWindows.get("pullRequests")?.title).toBe("Pull Requests");
    expect(c.editorKinds.has(TIMELINE_KIND)).toBe(true);
    for (const id of [
      "github.pullRequests",
      "github.createPullRequest",
      "github.checkoutPullRequest",
      "github.openInBrowser",
      "github.refresh",
      "github.pullRequest.show",
      "github.pullRequest.showTimeline",
      "github.pullRequest.refresh",
      "github.pullRequest.timeline.refresh",
      "github.pullRequest.openInBrowser",
      "github.pullRequest.copyUrl",
      "github.pullRequest.checkoutBranch",
      "github.pullRequest.openInWorktree",
      "github.pullRequest.submitReview",
      "github.pullRequest.toggleViewed",
      "github.selectOpenedPullRequest",
      "github.changeRepository",
    ])
      expect(getAction(id), id).toBeDefined();
  });

  it("shows gh's state when it is not ready", () => {
    useGhRepository.setState({ availability: { kind: "notInstalled" } });
    render(<PullRequestsToolWindow />);
    expect(screen.getByText("GitHub CLI is not installed")).toBeTruthy();
  });

  it("offers the repository selector for several GitHub remotes", () => {
    useGhRepository.setState({
      availability: { kind: "ready", repo: {} as never, login: "me" },
      remotes: [
        { owner: "me", name: "app", remote: "origin", url: "" },
        { owner: "org", name: "app", remote: "upstream", url: "" },
      ],
      defaultRemote: { owner: "org", name: "app" },
    });
    render(<PullRequestsToolWindow />);
    expect(screen.getByText("View Pull Requests")).toBeTruthy();
  });

  it("shows the list tab, named after the repository, once connected", async () => {
    const ghApi = vi.spyOn(ipc.commands, "ghApi").mockResolvedValue({
      status: "ok",
      data: JSON.stringify({
        data: {
          search: {
            pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
            nodes: [],
          },
        },
      }),
    } as never);
    setCurrentRepository({ owner: "org", name: "app", id: "R1" });
    await act(async () => {
      useGhRepository.setState({
        availability: { kind: "ready", repo: {} as never, login: "me" },
        remotes: [{ owner: "org", name: "app", remote: "origin", url: "" }],
        connection: { coordinates: { owner: "org", name: "app" }, repository, currentUser: me },
      });
      render(
        <>
          <PullRequestsTabs />
          <PullRequestsToolWindow />
        </>,
      );
    });
    expect(screen.getByRole("tab", { name: /app/ })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search pull requests" })).toBeTruthy();
    const body = JSON.parse(ghApi.mock.calls[0]![0].body!) as { variables: { query: string; pageSize: number } };
    // First run: "Assigned to you".
    expect(body.variables).toMatchObject({ query: "type:pr repo:org/app is:open assignee:me", pageSize: 50 });
    await act(async () => openPullRequestTab(4));
    expect(screen.getByRole("tab", { name: /#4/ })).toBeTruthy();
  });
});
