import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IdeError, PushSelection, RemoteOp, Settings } from "@/bindings";

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  inspect: vi.fn(),
  remote: vi.fn(),
  remoteRepo: vi.fn(),
  destination: vi.fn(),
  commitTarget: vi.fn(),
  remotes: vi.fn(),
  editRemote: vi.fn(),
  branchInfo: vi.fn(),
  failure: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

const commit = (id: string, summary: string) => ({
  id,
  shortId: id,
  parents: ["c0"],
  summary,
  message: summary,
  author: "me",
  email: "me@example.com",
  timeMs: 0,
  refs: [],
});

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { path: string } }) => <div>diff view {input.path}</div>,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsRemotes: (repo: string | null) => ok(mocks.remotes(repo)),
      vcsBranchInfo: (repo: string | null) => ok(mocks.branchInfo(repo)),
      vcsEditRemote: mocks.editRemote,
      vcsBranches: () =>
        ok([
          { name: "feature", remote: false, current: true, upstream: null },
          { name: "origin/main", remote: true, current: false, upstream: null },
        ]),
      vcsLog: (repo: string, query: unknown) => {
        mocks.log(repo, query);
        return ok([commit("c2", "More"), commit("c1", "Work")]);
      },
      vcsCommitsChanges: () => ok([{ path: "src/A.java", oldPath: null, kind: "modified", before: "c0", after: "c2" }]),
      vcsCommitFiles: () => ok([{ path: "src/B.java", oldPath: null, kind: "modified" }]),
      vcsHasHook: () => ok(false),
      cancelRequest: () => ok(null),
      vcsDefaultPushTarget: (repo: string | null) => ok(mocks.destination(repo) ?? null),
      vcsPushTargetChoices: (repo: string | null, _request: number, branch: string | null, revision: string | null) => {
        const target = revision
          ? mocks.commitTarget(repo, revision)
          : { branch, destination: mocks.destination(repo) ?? null };
        return ok({ destinations: [], ...target });
      },
      vcsInspectPush: (_repo: string | null, _request: number, selection: PushSelection, live: boolean) =>
        ok(mocks.inspect(selection, live)),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.remote(op);
        mocks.remoteRepo(repo);
        const error = mocks.failure(op) as IdeError | undefined;
        return error ? Promise.resolve({ status: "error" as const, error }) : ok(null);
      },
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showPushDialog } from "../remoteUi";
import { useVcs } from "../store";
import { provideNotificationService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { getContext, setContext } from "@/platform/context";
import { pushAfterCommit } from "../commitUi";
import { registerVcsActions } from "../actions";

beforeEach(() => {
  localStorage.clear();
  mocks.log.mockReset();
  mocks.inspect.mockReset();
  mocks.remote.mockReset();
  mocks.remoteRepo.mockReset();
  mocks.destination.mockReset();
  mocks.commitTarget.mockReset();
  mocks.remotes.mockReset().mockReturnValue([{ name: "origin", url: "/remotes/origin" }]);
  mocks.editRemote.mockReset();
  mocks.branchInfo.mockReset().mockReturnValue({
    head: "feature",
    headCommit: "c2",
    upstream: null,
    operation: null,
  });
  mocks.failure.mockReset();
  useProject.setState({ settings: null });
  provideNotificationService({ notify: () => {}, expire: () => {} });
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    repo: "/p",
    available: false,
    branch: { head: "feature", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    branches: [],
    branchesLoaded: false,
  });
});

afterEach(() => {
  for (const cancel of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(cancel);
});

it("lists only the commits no remote branch has for a branch without upstream", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  expect((await screen.findAllByText("Work")).length).toBeGreaterThan(0);
  await waitFor(() =>
    expect(mocks.log).toHaveBeenCalledWith(
      "/p",
      expect.objectContaining({ branch: "HEAD", range: "HEAD ^refs/remotes/origin/main", limit: 1000 }),
    ),
  );
  expect(mocks.log).not.toHaveBeenCalledWith("/p", expect.objectContaining({ range: null, limit: 50 }));
});

it("reviews a named source by its local branch ref even when it is checked out", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p", branch: "feature" }));
  expect(await screen.findByText("Work")).toBeInTheDocument();
  expect(mocks.log).toHaveBeenCalledWith(
    "/p",
    expect.objectContaining({ branch: "refs/heads/feature", range: "refs/heads/feature ^refs/remotes/origin/main" }),
  );
  expect(mocks.log).not.toHaveBeenCalledWith("/p", expect.objectContaining({ branch: "HEAD" }));
});

it("pushes a Git Log selection to its containing branch's configured destination in the commit's repository", async () => {
  useVcs.setState({ roots: ["/p", "/p/nested"] });
  const selection = { branch: "topic", revision: "c1", remote: "origin", target: "review/partial" };
  mocks.commitTarget.mockReturnValue({
    branch: "topic",
    destination: { selection, setUpstream: false },
  });
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p/nested", revision: commit("c1", "Selected") }));

  expect(await screen.findByText("Push Commits to origin/review/partial")).toBeInTheDocument();
  expect(screen.getByText("topic up to c1 →")).toBeInTheDocument();
  expect(mocks.commitTarget).toHaveBeenCalledWith("/p/nested", "c1");
  expect(mocks.destination).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Push$/ }));
  await waitFor(() =>
    expect(mocks.remote).toHaveBeenCalledWith(expect.objectContaining({ op: "pushSelected", selection })),
  );
  expect(mocks.remoteRepo).toHaveBeenCalledWith("/p/nested");
});

it("defines the first remote in the selected commit's repository and keeps the selected revision", async () => {
  useVcs.setState({ roots: ["/p", "/p/nested"] });
  const previous = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  const selection = { branch: "topic", revision: "c1", remote: "origin", target: "topic" };
  let configured = false;
  mocks.remotes.mockImplementation(() => (configured ? [{ name: "origin", url: "/remotes/local" }] : []));
  mocks.commitTarget.mockImplementation(() => ({
    branch: "topic",
    destination: configured ? { selection, setUpstream: false } : null,
  }));
  mocks.editRemote
    .mockResolvedValueOnce({ status: "error", error: { kind: "io", message: "Could not write config" } })
    .mockImplementation(async () => {
      configured = true;
      return { status: "ok", data: null };
    });
  try {
    render(<VcsDialogHost />);
    await act(() => showPushDialog({ repo: "/p/nested", revision: commit("c1", "Selected") }));
    fireEvent.click(await screen.findByRole("button", { name: "Define Remote…" }));
    expect(screen.getByRole("button", { name: "Push", hidden: true })).toBeDisabled();
    expect(await screen.findByRole("dialog", { name: "Define Remote" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: "/remotes/local" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not write config");
    expect(screen.getByRole("textbox", { name: "URL" })).toHaveValue("/remotes/local");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("dialog", { name: "Push Commits to origin/topic" })).toBeInTheDocument();
    expect(mocks.editRemote).toHaveBeenLastCalledWith("/p/nested", {
      op: "add",
      name: "origin",
      url: "/remotes/local",
    });
    expect(mocks.commitTarget.mock.calls).toEqual([
      ["/p/nested", "c1"],
      ["/p/nested", "c1"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() =>
      expect(mocks.remote).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "pushSelected",
          selection,
          set_upstream: false,
        }),
      ),
    );
    expect(mocks.remoteRepo).toHaveBeenCalledWith("/p/nested");
  } finally {
    unregister();
    setContext("vcsAvailable", previous);
  }
});

it("requires a valid destination before pushing an edited branch name", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog());
  const target = await screen.findByRole("combobox", { name: "Target branch" });
  const push = screen.getByRole("button", { name: "Push" });
  fireEvent.change(target, { target: { value: "" } });
  expect(target).toHaveAttribute("aria-invalid", "true");
  expect(push).toBeDisabled();
  fireEvent.change(target, { target: { value: "broken..ref" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Invalid branch name");
  expect(push).toBeDisabled();
  expect(mocks.remote).not.toHaveBeenCalled();
  fireEvent.change(target, { target: { value: "review/topic" } });
  expect(push).toBeEnabled();
});

it("suggests successful non-default destinations when the same branch is pushed again", async () => {
  const selection = { branch: "feature", revision: null, remote: "origin", target: "review/default" };
  const branch = { ...useVcs.getState().branch!, upstream: "origin/review/default" };
  useVcs.setState({ branch });
  mocks.branchInfo.mockReturnValue(branch);
  mocks.destination.mockReturnValue({ selection, setUpstream: false });
  mocks.failure.mockImplementation((op: RemoteOp) => {
    if (op.op !== "pushSelected") return;
    if (op.selection.target === "review/failed") return { kind: "io", message: "remote unavailable" };
    if (op.selection.target === "review/tags") {
      return {
        kind: "internal",
        message: "!\trefs/tags/v1:refs/tags/v1\t[rejected] (already exists)",
        data: {
          type: "pushPartiallyApplied",
          report: {
            remote: "origin",
            refs: [{ reference: "refs/heads/review/tags", status: "created", commits: null }],
          },
        },
      } satisfies IdeError;
    }
    if (op.selection.target === "review/upstream" && op.set_upstream) {
      mocks.destination.mockReturnValue({ selection: op.selection, setUpstream: false });
    }
  });
  render(<VcsDialogHost />);
  for (const name of [
    "review/default",
    "review/failed",
    "review/old",
    "review/new",
    "review/tags",
    "review/old",
    "review/upstream",
  ]) {
    await act(() => showPushDialog());
    const field = await screen.findByRole("combobox", { name: "Target branch" });
    fireEvent.change(field, { target: { value: name } });
    if (name === "review/tags") fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
    if (name === "review/upstream") fireEvent.click(screen.getByRole("checkbox", { name: "Set upstream" }));
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(field).not.toBeInTheDocument());
    await waitFor(() => expect(useVcs.getState().remoteBusy).toBeNull());
  }
  await act(() => showPushDialog());
  const field = await screen.findByRole("combobox", { name: "Target branch" });
  expect(field).toHaveValue("review/upstream");
  fireEvent.change(field, { target: { value: "review" } });
  expect(screen.getAllByRole("option", { name: /recently pushed/i }).map((row) => row.textContent)).toEqual([
    "review/oldRecently pushed",
    "review/tagsRecently pushed",
    "review/newRecently pushed",
  ]);
});

it("offers Project Update in the preview only for the checked-out branch and its actual upstream", async () => {
  const info = { head: "feature", headCommit: "c2", upstream: "origin/main", ahead: 1, behind: 1, operation: null };
  useVcs.setState({ branch: info });
  mocks.branchInfo.mockReturnValue(info);
  mocks.inspect.mockReturnValue({
    state: "diverged",
    localTip: "c2",
    remoteTip: "r2",
    remoteCommits: 1,
    remoteChecked: true,
  });
  render(<VcsDialogHost />);
  await act(() => showPushDialog());
  expect(await screen.findByRole("button", { name: "Update Project" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Target branch" }), { target: { value: "untracked" } });
  expect(screen.queryByRole("button", { name: "Update Project" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"origin/untracked"'));
  expect(screen.queryByRole("button", { name: "Update Project" })).toBeNull();
});

it("fetches a rejected destination and reopens the exact Git Log commit and custom branch", async () => {
  const previous = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  const actions: Array<{ label: string; run: () => void }> = [];
  provideNotificationService({
    notify: (note) => {
      if (note.title === "Push rejected") actions.push(...(note.actions ?? []));
    },
    expire: () => {},
  });
  const source = { branch: "topic", revision: "c1", remote: "origin", target: "topic" };
  const reviewed = { ...source, target: "review/partial" };
  const destination = { selection: source, setUpstream: false };
  mocks.commitTarget.mockReturnValue({ branch: "topic", destination, destinations: [destination] });
  mocks.destination.mockReturnValue(destination);
  mocks.failure.mockImplementation((op: RemoteOp) =>
    op.op === "pushSelected"
      ? { kind: "internal", message: "!\tc1:refs/heads/review/partial\t[rejected] (fetch first)" }
      : undefined,
  );
  let fetched = false;
  mocks.remote.mockImplementation((op: RemoteOp) => {
    if (op.op === "fetchPushTarget") fetched = true;
  });
  mocks.inspect.mockImplementation(() =>
    fetched
      ? { state: "diverged", localTip: "c1", remoteTip: "r2", remoteCommits: 1, remoteChecked: true }
      : { state: "ready", localTip: "c1", remoteTip: "r1", remoteCommits: 0, remoteChecked: true },
  );
  try {
    render(<VcsDialogHost />);
    await act(() => showPushDialog({ repo: "/p/nested", revision: commit("c1", "Selected") }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Target branch" }), {
      target: { value: "review/partial" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(actions.map(({ label }) => label)).toEqual(["Fetch and Review…"]));
    await act(async () => actions[0]!.run());
    expect(await screen.findByRole("dialog", { name: "Push Commits to origin/review/partial" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Show in Git Log" })).toBeInTheDocument();
    expect(screen.getByText("topic up to c1 →")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update Project" })).toBeNull();
    expect(mocks.remote.mock.calls.map(([op]) => op.op)).toEqual(["pushSelected", "fetchPushTarget"]);
    expect(mocks.remote).toHaveBeenLastCalledWith({ op: "fetchPushTarget", selection: reviewed });
    expect(mocks.remoteRepo.mock.calls).toEqual([["/p/nested"], ["/p/nested"]]);
    expect(mocks.log).toHaveBeenCalledWith("/p/nested", expect.objectContaining({ branch: "c1", range: "r2..c1" }));
  } finally {
    unregister();
    setContext("vcsAvailable", previous);
  }
});

it("switches a Git Log push to the chosen remote's refspec and keeps a manually entered branch", async () => {
  mocks.remotes.mockReturnValue([{ name: "origin" }, { name: "fork" }]);
  const source = { branch: "topic", revision: "c1" };
  const origin = { selection: { ...source, remote: "origin", target: "publish/topic" }, setUpstream: false };
  const fork = {
    selection: { ...source, remote: "fork", target: "refs/for/topic", specialRef: true },
    setUpstream: false,
  };
  mocks.commitTarget.mockReturnValue({ branch: "topic", destination: origin, destinations: [origin, fork] });
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p", revision: commit("c1", "Selected") }));
  const target = await screen.findByRole("combobox", { name: "Target branch" });
  expect(target).toHaveValue("publish/topic");
  const remote = screen.getByRole("button", { name: "Remote" });
  const choose = async (name: string) => {
    fireEvent.click(remote);
    fireEvent.click(await screen.findByRole("option", { name }));
  };
  await choose("fork");
  expect(target).toHaveValue("refs/for/topic");
  expect(screen.getByRole("checkbox", { name: "Force (with lease)" })).toBeDisabled();
  await choose("origin");
  expect(target).toHaveValue("publish/topic");
  fireEvent.change(target, { target: { value: "origin/review/custom" } });
  await choose("fork");
  expect(target).toHaveValue("review/custom");
  fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
  fireEvent.click(screen.getByRole("button", { name: "Tags to push" }));
  fireEvent.click(await screen.findByRole("option", { name: "Current Branch" }));
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() =>
    expect(mocks.remote).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "pushSelected",
        selection: { ...source, remote: "fork", target: "review/custom" },
        tags: "currentBranch",
      }),
    ),
  );
  expect(mocks.commitTarget).toHaveBeenCalledExactlyOnceWith("/p", "c1");
});

it("remembers the submitted tag option for the project without saving cancelled edits", async () => {
  render(<VcsDialogHost />);
  const open = async () => {
    await act(() => showPushDialog());
    await screen.findByRole("combobox", { name: "Target branch" });
    return screen.getByRole("checkbox", { name: "Push tags:" });
  };
  const submit = async (checkbox: HTMLElement) => {
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(checkbox).not.toBeInTheDocument());
    await waitFor(() => expect(useVcs.getState().remoteBusy).toBeNull());
  };

  const first = await open();
  expect(first).not.toBeChecked();
  fireEvent.click(first);
  fireEvent.click(screen.getByRole("button", { name: "Tags to push" }));
  fireEvent.click(await screen.findByRole("option", { name: "Current Branch" }));
  await submit(first);
  expect(mocks.remote).toHaveBeenLastCalledWith(expect.objectContaining({ tags: "currentBranch" }));

  const draft = await open();
  expect(draft).toBeChecked();
  expect(screen.getByRole("button", { name: "Tags to push" })).toHaveTextContent("Current Branch");
  fireEvent.click(draft);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await open()).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  useVcs.setState({ root: "/other", repo: "/other", roots: ["/other"] });
  expect(await open()).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"] });

  const turnOff = await open();
  expect(turnOff).toBeChecked();
  fireEvent.click(turnOff);
  await submit(turnOff);
  expect(mocks.remote).toHaveBeenLastCalledWith(expect.objectContaining({ tags: null }));
  expect(await open()).not.toBeChecked();
});

it("offers to define another remote without changing the destination being reviewed", async () => {
  const previous = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  const names = ["origin"];
  mocks.remotes.mockImplementation(() => names.map((name) => ({ name })));
  mocks.editRemote.mockImplementation(async () => {
    names.push("backup");
    return { status: "ok", data: null };
  });
  try {
    render(<VcsDialogHost />);
    await act(() => showPushDialog());
    fireEvent.change(await screen.findByRole("combobox", { name: "Target branch" }), {
      target: { value: "review/custom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.click(await screen.findByRole("option", { name: "Define Remote…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "backup" } });
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: "/remotes/backup" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("dialog", { name: "Push Commits to origin/review/custom" })).toBeInTheDocument();
    const remote = screen.getByRole("button", { name: "Remote" });
    expect(remote).toHaveTextContent("origin");
    fireEvent.click(remote);
    expect(await screen.findByRole("option", { name: "backup" })).toBeInTheDocument();
    expect(mocks.editRemote).toHaveBeenCalledExactlyOnceWith("/p", {
      op: "add",
      name: "backup",
      url: "/remotes/backup",
    });
  } finally {
    unregister();
    setContext("vcsAvailable", previous);
  }
});

it("shows the selected file's diff under both panes until it is closed or another commit is picked", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  fireEvent.mouseDown(await screen.findByText("A.java"));
  expect(await screen.findByText("src/A.java")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close Diff" }));
  expect(screen.queryByText("src/A.java")).toBeNull();

  fireEvent.mouseDown(screen.getByText("A.java"));
  expect(await screen.findByText("src/A.java")).toBeInTheDocument();

  const older = screen.getByRole("option", { name: /Work/ });
  fireEvent.mouseDown(older);
  fireEvent.click(older);
  expect(await screen.findByText("B.java")).toBeInTheDocument();
  expect(screen.queryByText("src/A.java")).toBeNull();
});

it("fetches the reviewed destination and refreshes the warning when the target changes", async () => {
  let fetched = false;
  mocks.inspect.mockImplementation(({ target }: PushSelection, live: boolean) =>
    target === "feature" && live
      ? {
          state: fetched ? "diverged" : "fetchRequired",
          localTip: "c2",
          remoteTip: "r1",
          remoteCommits: fetched ? 1 : 0,
        }
      : { state: "ready", localTip: "c2", remoteTip: null, remoteCommits: 0 },
  );
  mocks.remote.mockImplementation((op: RemoteOp) => {
    if (op.op === "fetchPushTarget") fetched = true;
  });
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  const fetch = await screen.findByRole("button", { name: /^Fetch$/ });
  expect(screen.queryByRole("button", { name: /^Push$/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Force (with lease)" })).toBeDisabled();
  fireEvent.click(fetch);
  expect(mocks.remote).toHaveBeenCalledWith({
    op: "fetchPushTarget",
    selection: { branch: "feature", revision: null, remote: "origin", target: "feature" },
  });
  expect(await screen.findByRole("button", { name: "Show in Git Log" })).toBeInTheDocument();

  fireEvent.change(screen.getByRole("combobox", { name: "Target branch" }), { target: { value: "alternate" } });
  expect(screen.queryByRole("button", { name: "Show in Git Log" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Push$/ }));
  await waitFor(() =>
    expect(mocks.remote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "pushSelected",
        selection: { branch: "feature", revision: null, remote: "origin", target: "alternate" },
      }),
    ),
  );
});

it("checks a configured destination and fetches its history before falling back to the Push dialog", async () => {
  useProject.setState({ settings: { vcs: { git: { showPushDialog: false } } } as Settings });
  const selection = { branch: "feature", revision: null, remote: "origin", target: "review/feature" };
  mocks.destination.mockReturnValue({ selection, setUpstream: false });
  let fetched = false;
  mocks.inspect.mockImplementation(() => ({
    state: fetched ? "diverged" : "fetchRequired",
    localTip: "c2",
    remoteTip: "r1",
    remoteCommits: fetched ? 1 : 0,
    remoteChecked: true,
  }));
  mocks.remote.mockImplementation((op: RemoteOp) => {
    if (op.op === "fetchPushTarget") fetched = true;
  });
  render(<VcsDialogHost />);
  await act(() => pushAfterCommit([{ repo: "/p", id: "c2" }]));

  expect(await screen.findByRole("dialog", { name: "Push Commits to origin/review/feature" })).toBeInTheDocument();
  expect(mocks.remote.mock.calls).toEqual([[{ op: "fetchPushTarget", selection }]]);
});

it("pushes the checked source and destination directly when the committed tip can be pushed", async () => {
  useProject.setState({ settings: { vcs: { git: { showPushDialog: false } } } as Settings });
  const selection = { branch: "feature", revision: null, remote: "origin", target: "review/feature" };
  const inspection = { state: "ready", localTip: "c2", remoteTip: "", remoteCommits: 0, remoteChecked: true };
  mocks.destination.mockReturnValue({ selection, setUpstream: true });
  mocks.inspect.mockReturnValue(inspection);
  render(<VcsDialogHost />);
  await act(() => pushAfterCommit([{ repo: "/p", id: "c2" }]));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.remote).toHaveBeenCalledExactlyOnceWith({
    op: "pushSelected",
    selection,
    inspected: inspection,
    set_upstream: true,
    force_with_lease: false,
    tags: null,
    no_verify: false,
  });
});

it("opens the Push dialog if the source moved after Commit", async () => {
  useProject.setState({ settings: { vcs: { git: { showPushDialog: false } } } as Settings });
  const selection = { branch: "feature", revision: null, remote: "origin", target: "review/feature" };
  mocks.destination.mockReturnValue({ selection, setUpstream: false });
  mocks.inspect.mockReturnValue({
    state: "ready",
    localTip: "later",
    remoteTip: "r1",
    remoteCommits: 0,
    remoteChecked: true,
  });
  render(<VcsDialogHost />);
  await act(() => pushAfterCommit([{ repo: "/p", id: "c2" }]));

  expect(await screen.findByRole("dialog", { name: "Push Commits to origin/review/feature" })).toBeInTheDocument();
  expect(mocks.remote).not.toHaveBeenCalled();
});

it("shows and pushes the detached commit from when the dialog opened", async () => {
  const reviewed = "a".repeat(40);
  const branch = { head: null, headCommit: reviewed, upstream: null, ahead: 0, behind: 0, operation: null };
  useVcs.setState({ branch });
  const selection = { branch: null, revision: reviewed, remote: "origin", target: "detached2" };
  mocks.destination.mockReturnValue({ selection, setUpstream: false });
  mocks.inspect.mockReturnValue({
    state: "ready",
    localTip: reviewed,
    remoteTip: "",
    remoteCommits: 0,
    remoteChecked: true,
  });
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  expect(await screen.findByRole("dialog", { name: "Push Commits to origin/detached2" })).toBeInTheDocument();
  expect(screen.getByTitle(`Detached HEAD at ${reviewed}`)).toHaveTextContent("aaaaaaaa");
  expect(screen.queryByRole("checkbox", { name: "Set upstream" })).toBeNull();
  act(() => useVcs.setState({ branch: { ...branch, headCommit: "b".repeat(40) } }));
  fireEvent.click(screen.getByRole("button", { name: /^Push$/ }));
  await waitFor(() =>
    expect(mocks.remote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        op: "pushSelected",
        selection,
        set_upstream: false,
      }),
    ),
  );
});

it.each([
  ["", true],
  ["r1", false],
])("directly pushes a detached commit only to a new destination (%s)", async (remoteTip, pushes) => {
  const revision = "a".repeat(40);
  useVcs.setState({
    branch: { head: null, headCommit: revision, upstream: null, ahead: 0, behind: 0, operation: null },
  });
  useProject.setState({ settings: { vcs: { git: { showPushDialog: false } } } as Settings });
  const selection = { branch: null, revision, remote: "origin", target: "detached2" };
  const inspected = { state: "ready", localTip: revision, remoteTip, remoteCommits: 0, remoteChecked: true };
  mocks.destination.mockReturnValue({ selection, setUpstream: false });
  mocks.inspect.mockReturnValue(inspected);
  render(<VcsDialogHost />);
  await act(() => pushAfterCommit([{ repo: "/p", id: revision }]));

  if (pushes) {
    expect(mocks.remote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        op: "pushSelected",
        selection,
        inspected,
        set_upstream: false,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  } else {
    expect(await screen.findByRole("dialog", { name: "Push Commits to origin/detached2" })).toBeInTheDocument();
    expect(mocks.remote).not.toHaveBeenCalled();
  }
});
