import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getAction, registerAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import * as ipc from "@/platform/ipc";
import { provideToolWindowService, useContributions, type ToolWindowService } from "@/workbench/contributions";
import { activate } from "../index";
import { setCurrentRepository } from "../api/client";
import type { GHRepository, GHUser } from "../api/types";
import { useGhProjectAccount } from "../data/account";
import * as repositoryData from "../data/repository";
import { useGhRepository } from "../data/repository";
import {
  PullRequestsHeaderActions,
  PullRequestsTabs,
  PullRequestsToolWindow,
  headerMenu,
} from "./PullRequestsToolWindow";
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
    useGhProjectAccount.setState({ status: null, loading: false, saving: false, revision: 0 });
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

  it("opens the tool window for Change Repository or Account while not connected", async () => {
    const show = vi.fn();
    provideToolWindowService({ show } as unknown as ToolWindowService);
    useGhRepository.setState({ availability: { kind: "notInstalled" } });
    await getAction("github.changeRepository")!.run({ arg: undefined, ctx: { projectOpen: true } });
    expect(show).toHaveBeenCalledWith("pullRequests", true);
  });

  it("shows gh's state when it is not ready and installs gh on click", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    const dispose = registerAction({ id: "tools.install", title: "Install", run: install });
    const refresh = vi.spyOn(repositoryData, "refreshConnection").mockResolvedValue(undefined);
    try {
      useGhRepository.setState({ availability: { kind: "notInstalled" } });
      render(<PullRequestsToolWindow />);
      expect(screen.getByText("GitHub CLI is not installed")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Install GitHub CLI" }));
      await waitFor(() => expect(install).toHaveBeenCalledWith(expect.objectContaining({ arg: "gh" })));
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    } finally {
      refresh.mockRestore();
      dispose();
    }
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
        connection: {
          coordinates: { owner: "org", name: "app" },
          repository,
          currentUser: me,
          root: null,
          remotes: [],
        },
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
    const body = JSON.parse(ghApi.mock.calls[0]![1].body!) as { variables: { query: string; pageSize: number } };
    // First run: every open pull request.
    expect(body.variables).toMatchObject({ query: "type:pr repo:org/app is:open", pageSize: 50 });
    await act(async () => openPullRequestTab(4));
    expect(screen.getByRole("tab", { name: /#4/ })).toBeTruthy();
  });

  it("suggests a matching GitHub account in the header menu and shows the active account badge", () => {
    const connState = {
      connection: {
        coordinates: { owner: "org", name: "app" },
        repository,
        currentUser: { ...me, login: "alice" },
        root: null,
        remotes: [],
      },
      remotes: [{ owner: "org", name: "app", remote: "origin", url: "" }],
    };
    expect(headerMenu(connState, null)).toEqual([]);
    const multiStatus = {
      ghInstalled: true,
      accounts: [
        { login: "alice", active: true },
        { login: "alice-work", active: false },
      ],
      configuredAccount: "",
      effectiveAccount: "alice",
      suggestedAccount: "alice-work",
    };
    expect(headerMenu(connState, multiStatus).map((i) => ("label" in i ? i.label : ""))).toEqual([
      "Use alice-work for this project",
      "Change Repository or Account…",
    ]);

    useGhRepository.setState({
      availability: { kind: "ready", repo: {} as never, login: "alice" },
      ...connState,
    });
    useGhProjectAccount.setState({ status: multiStatus });
    render(<PullRequestsHeaderActions />);
    const badge = screen.getByRole("button", { name: "@alice" });
    expect(badge).toHaveAttribute("title", "Use alice-work for this project");
  });
});
