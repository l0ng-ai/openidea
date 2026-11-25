import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Branch, DefaultPushTarget, LogQuery, RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  failing: new Set<string>(),
  upToDate: new Set<string>(),
  detached: new Map<string, string>(),
  named: new Map<string, Branch>(),
  destinations: new Map<string, DefaultPushTarget>(),
  alternatives: new Map<string, DefaultPushTarget[]>(),
  unconfigured: new Set<string>(),
  editRemote: vi.fn(),
  defaultTarget: vi.fn(),
  log: vi.fn(),
  changes: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/workbench/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/messages")>()),
  ask: mocks.ask,
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const remote = (name: string) => ({ name, fetchUrl: `/remotes/${name}`, pushUrl: `/remotes/${name}` });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string) => {
        const detached = mocks.detached.get(repo);
        return ok({
          head: detached ? null : "feat-x",
          headCommit: detached ?? "c1",
          upstream: detached ? null : "origin/feat-x",
          ahead: 1,
          behind: 0,
          operation: null,
          repo,
        });
      },
      vcsBranches: (repo: string) => ok(mocks.named.has(repo) ? [mocks.named.get(repo)] : []),
      vcsPushTargetChoices: (repo: string, _request: number, branch: string | null) => {
        mocks.defaultTarget(repo, branch);
        const revision = mocks.detached.get(repo);
        const destination = branch
          ? (mocks.destinations.get(repo) ?? null)
          : revision
            ? { selection: { branch: null, revision, remote: "origin", target: "detached2" }, setUpstream: false }
            : null;
        return ok({ branch, destination, destinations: mocks.alternatives.get(repo) ?? [] });
      },
      vcsRemotes: (repo: string) =>
        ok(
          mocks.unconfigured.has(repo) ? [] : repo === "/p/b" ? [remote("origin"), remote("fork")] : [remote("origin")],
        ),
      vcsEditRemote: (repo: string, operation: unknown) => {
        mocks.editRemote(repo, operation);
        mocks.unconfigured.delete(repo);
        return ok(null);
      },
      vcsLog: (repo: string, query: LogQuery) => {
        mocks.log(repo, query);
        return ok(
          mocks.upToDate.has(repo)
            ? []
            : [
                {
                  id: `${repo}-1`,
                  shortId: "c1",
                  parents: ["c0"],
                  summary: query.branch === "refs/heads/review" ? `Review ${repo.slice(3)}` : "Work",
                  message: "Work",
                  author: "me",
                  email: "me@example.com",
                  timeMs: 0,
                },
              ],
        );
      },
      vcsCommitFiles: (repo: string) => {
        mocks.changes(repo);
        return ok([{ path: `${repo.slice(3)}.txt`, oldPath: null, kind: "modified" }]);
      },
      vcsCommitsChanges: (repo: string) => {
        mocks.changes(repo);
        return ok([{ path: `${repo.slice(3)}.txt`, oldPath: null, kind: "modified", before: "c0", after: "c1" }]);
      },
      vcsHasHook: () => ok(false),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.ops.push({ repo, op });
        return repo && mocks.failing.has(repo)
          ? Promise.resolve({ status: "error", error: { kind: "failed", message: "remote hung up" } })
          : ok(null);
      },
      cancelRequest: () => ok(null),
    },
  };
});

import { provideNotificationService } from "@/workbench/contributions";
import { getContext, setContext } from "@/platform/context";
import { registerVcsActions } from "../actions";
import { commonBranchMenu } from "../branchMenu";
import { VcsDialogHost } from "../dialogs";
import { showPushDialog } from "../remoteUi";
import { useVcs } from "../store";

type Note = { title: string; body?: string };
let notes: Note[] = [];

beforeEach(() => {
  localStorage.clear();
  mocks.ops = [];
  mocks.failing = new Set();
  mocks.upToDate = new Set();
  mocks.detached = new Map();
  mocks.named = new Map();
  mocks.destinations = new Map();
  mocks.alternatives.clear();
  mocks.unconfigured.clear();
  mocks.editRemote.mockReset();
  mocks.defaultTarget.mockClear();
  mocks.log.mockClear();
  mocks.changes.mockReset();
  mocks.ask.mockReset();
  mocks.ask.mockResolvedValue({ button: "force", checked: false });
  notes = [];
  useVcs.setState({ root: "/p", roots: ["/p/a", "/p/b", "/p/c"], repo: "/p/a", remoteBusy: null, available: false });
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

afterEach(() => {
  for (const cancel of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(cancel);
});

function check(...repos: string[]) {
  for (const name of repos) fireEvent.click(screen.getByRole("checkbox", { name }));
}

function reviewBranch(repo: string, remote: string, target: string) {
  mocks.named.set(repo, {
    name: "review",
    remote: false,
    current: false,
    upstream: "origin/previous",
    commit: `review-${repo}`,
    ahead: 1,
    behind: 0,
    lastCommitMs: 0,
  });
  mocks.destinations.set(repo, { selection: { branch: "review", revision: null, remote, target }, setUpstream: false });
}

it("previews and pushes the named branch and configured destination of each selected repository", async () => {
  reviewBranch("/p/a", "origin", "client-review");
  reviewBranch("/p/b", "fork", "server-review");
  const active = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  try {
    render(<VcsDialogHost />);
    const menu = commonBranchMenu(
      { name: "review", remote: false, current: false, favorite: false, upstream: true },
      ["/p/a", "/p/b"],
      "feat-x",
    );
    const push = menu.find((item) => "label" in item && item.label === "Push…");
    if (!push || !("run" in push) || !push.run) throw new Error("Branch Push is missing");
    await act(() => push.run!());
    expect(await screen.findByRole("combobox", { name: "Target branch of a" })).toHaveValue("client-review");
    expect(screen.getByRole("combobox", { name: "Target branch of b" })).toHaveValue("server-review");
    expect(screen.queryByRole("combobox", { name: "Target branch of c" })).toBeNull();
    expect(screen.getByText("Review a")).toBeInTheDocument();
    expect(screen.getByText("Review b")).toBeInTheDocument();
    expect(screen.queryByText("Work")).toBeNull();
    expect(mocks.defaultTarget.mock.calls).toEqual([
      ["/p/a", "review"],
      ["/p/b", "review"],
    ]);
    expect(mocks.log).toHaveBeenCalledWith(
      "/p/b",
      expect.objectContaining({
        branch: "refs/heads/review",
        range: "refs/remotes/fork/server-review..refs/heads/review",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(mocks.ops).toHaveLength(2));
    expect(mocks.ops).toMatchObject([
      {
        repo: "/p/a",
        op: { op: "pushSelected", selection: { branch: "review", remote: "origin", target: "client-review" } },
      },
      {
        repo: "/p/b",
        op: { op: "pushSelected", selection: { branch: "review", remote: "fork", target: "server-review" } },
      },
    ]);
  } finally {
    unregister();
    setContext("vcsAvailable", active);
  }
});

it("names a repository where the selected branch vanished without substituting its current branch", async () => {
  reviewBranch("/p/a", "origin", "client-review");
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repositories: ["/p/a", "/p/b"], branch: "review" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("b Branch 'review' is no longer available");
  expect(screen.queryByRole("combobox", { name: "Target branch of b" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]).toMatchObject({ repo: "/p/a", op: { selection: { branch: "review" } } });
});

it("defines the first remote for one checked repository and preserves the other row's destination", async () => {
  mocks.unconfigured.add("/p/b");
  reviewBranch("/p/a", "origin", "a-review");
  reviewBranch("/p/b", "origin", "b-review");
  const previous = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  try {
    render(<VcsDialogHost />);
    await act(() => showPushDialog({ repositories: ["/p/a", "/p/b"], branch: "review" }));
    const a = await screen.findByRole("combobox", { name: "Target branch of a" });
    fireEvent.change(a, { target: { value: "custom/a" } });
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Define Remote in b" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "URL" }), { target: { value: "/remotes/local-b" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const b = await screen.findByRole("combobox", { name: "Target branch of b" });
    expect(b).toHaveValue("b-review");
    expect(a).toHaveValue("custom/a");
    expect(push).toBeEnabled();
    fireEvent.change(b, { target: { value: "origin/" } });
    expect(b).toHaveAttribute("aria-invalid", "true");
    expect(push).toBeDisabled();
    expect(mocks.ops).toHaveLength(0);
    fireEvent.change(b, { target: { value: "b-review" } });
    fireEvent.click(push);
    await waitFor(() => expect(mocks.ops).toHaveLength(2));
    expect(mocks.editRemote).toHaveBeenCalledExactlyOnceWith("/p/b", {
      op: "add",
      name: "origin",
      url: "/remotes/local-b",
    });
    expect(mocks.ops).toMatchObject([
      { repo: "/p/a", op: { selection: { branch: "review", target: "custom/a" } } },
      { repo: "/p/b", op: { selection: { branch: "review", target: "b-review" } } },
    ]);
  } finally {
    unregister();
    setContext("vcsAvailable", previous);
  }
});

it("reviews only the rejected repositories and preserves a different source and target per row", async () => {
  reviewBranch("/p/b", "origin", "defaults/b");
  const a = { branch: "feat-x", revision: "selected-a", remote: "origin", target: "review/a" };
  const b = { branch: "review", revision: null, remote: "fork", target: "review/b" };
  render(<VcsDialogHost />);
  await act(() =>
    showPushDialog({
      review: [
        { repo: "/p/a", selection: a },
        { repo: "/p/b", selection: b },
      ],
    }),
  );
  expect(await screen.findByRole("combobox", { name: "Target branch of a" })).toHaveValue("review/a");
  expect(screen.getByRole("combobox", { name: "Target branch of b" })).toHaveValue("review/b");
  expect(screen.queryByRole("combobox", { name: "Target branch of c" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remote of b" })).toHaveTextContent("fork");
  expect(screen.getByRole("checkbox", { name: "Force (with lease)" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(2));
  expect(mocks.ops).toMatchObject([
    { repo: "/p/a", op: { selection: a, set_upstream: false } },
    { repo: "/p/b", op: { selection: b } },
  ]);
});

it("pushes each repository with tags to its own remote and target branch, reporting the one that failed", async () => {
  mocks.failing.add("/p/b");
  mocks.alternatives.set("/p/b", [
    { selection: { branch: "feat-x", revision: null, remote: "fork", target: "publish/server" }, setUpstream: false },
  ]);
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  const targetOfA = await screen.findByRole("combobox", { name: "Target branch of a" });
  expect(targetOfA).toHaveValue("feat-x");
  expect(screen.getByRole("checkbox", { name: "Push tags:" })).toBeInTheDocument();
  fireEvent.change(targetOfA, { target: { value: "release-2.1" } });

  expect(screen.getByRole("button", { name: "Remote of a" })).toHaveTextContent("origin");
  fireEvent.click(screen.getByRole("button", { name: "Remote of b" }));
  fireEvent.click(await screen.findByRole("option", { name: "fork" }));
  expect(screen.getByRole("combobox", { name: "Target branch of b" })).toHaveValue("publish/server");
  expect(targetOfA).toHaveValue("release-2.1");
  fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
  fireEvent.click(screen.getByRole("button", { name: "Tags to push" }));
  fireEvent.click(await screen.findByRole("option", { name: "Current Branch" }));
  await waitFor(() =>
    expect(mocks.log).toHaveBeenCalledWith(
      "/p/b",
      expect.objectContaining({ range: "refs/remotes/fork/publish/server..refs/heads/feat-x" }),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(3));

  expect(mocks.ops).toEqual([
    {
      repo: "/p/a",
      op: {
        op: "pushSelected",
        selection: { branch: "feat-x", revision: null, remote: "origin", target: "release-2.1" },
        force_with_lease: false,
        set_upstream: false,
        no_verify: false,
        tags: "currentBranch",
      },
    },
    {
      repo: "/p/b",
      op: {
        op: "pushSelected",
        selection: { branch: "feat-x", revision: null, remote: "fork", target: "publish/server" },
        force_with_lease: false,
        set_upstream: false,
        no_verify: false,
        tags: "currentBranch",
      },
    },
    {
      repo: "/p/c",
      op: {
        op: "pushSelected",
        force_with_lease: false,
        set_upstream: false,
        tags: "currentBranch",
        no_verify: false,
        selection: { branch: "feat-x", revision: null, remote: "origin", target: "feat-x" },
      },
    },
  ]);
  await waitFor(() => expect(notes.map((n) => n.title)).toContain("Push partially failed"));
  expect(notes.find((n) => n.title === "Push partially failed")?.body).toContain("Not pushed: b.");
});

const forceOf = (ops: typeof mocks.ops) =>
  ops.map(({ repo, op }) => [repo, "force_with_lease" in op ? op.force_with_lease : null]);
const askedTargets = () => mocks.ask.mock.calls.map(([r]) => (r as { body: string }).body.match(/to '(.*)'/)?.[1]);

async function openPushDialog() {
  render(<VcsDialogHost />);
  await act(() => showPushDialog());
  await screen.findByRole("combobox", { name: "Target branch of a" });
}

it("lists every repository on Push all, checks those with commits, expands none and shows no files", async () => {
  mocks.upToDate.add("/p/c");
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  await screen.findByRole("combobox", { name: "Target branch of a" });
  expect(screen.getByRole("combobox", { name: "Target branch of c" })).toBeInTheDocument();
  for (const name of ["a", "b"]) expect(screen.getByRole("checkbox", { name })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "c" })).not.toBeChecked();
  expect(screen.queryByText("Work")).toBeNull();
  expect(mocks.changes).not.toHaveBeenCalled();

  check("b");
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]?.repo).toBe("/p/a");
});

it("shows only the repository Push was invoked from without a checkbox, its files shown at once", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p/b" }));

  expect(await screen.findByText("Push Commits to b")).toBeInTheDocument();
  expect(await screen.findByText("b.txt")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Target branch of b" })).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Target branch of a" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Target branch of c" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "b" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]?.repo).toBe("/p/b");
});

it("pushes an up-to-date repository from its own Push… to another target branch", async () => {
  mocks.upToDate.add("/p/b");
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p/b" }));

  const target = await screen.findByRole("combobox", { name: "Target branch of b" });
  expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
  fireEvent.change(target, { target: { value: "release" } });
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]?.repo).toBe("/p/b");
});

it("asks to confirm each forced target and pushes nothing when one is declined", async () => {
  mocks.ask.mockResolvedValueOnce({ button: "force", checked: false }).mockResolvedValueOnce({ button: null });
  await openPushDialog();
  fireEvent.change(screen.getByRole("combobox", { name: "Target branch of a" }), { target: { value: "feat-a" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Force (with lease)" }));
  fireEvent.click(screen.getByRole("button", { name: "Force Push" }));

  await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(2));
  expect(askedTargets()).toEqual(["origin/feat-a", "origin/feat-x"]);
  expect(mocks.ops).toEqual([]);
  // Declining keeps the dialog open, as in the single-repository dialog.
  expect(screen.getByRole("button", { name: "Force Push" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
});

it("force pushes with lease once every target is confirmed", async () => {
  await openPushDialog();
  fireEvent.click(screen.getByRole("checkbox", { name: "Force (with lease)" }));
  fireEvent.click(screen.getByRole("button", { name: "Force Push" }));

  await waitFor(() => expect(mocks.ops).toHaveLength(3));
  // The three repositories push to the same target: one confirmation.
  expect(askedTargets()).toEqual(["origin/feat-x"]);
  expect(forceOf(mocks.ops)).toEqual([
    ["/p/a", true],
    ["/p/b", true],
    ["/p/c", true],
  ]);
});

it("does not ask about a protected target, which is never forced", async () => {
  await openPushDialog();
  fireEvent.change(screen.getByRole("combobox", { name: "Target branch of a" }), { target: { value: "main" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Force (with lease)" }));
  fireEvent.click(screen.getByRole("button", { name: "Force Push" }));

  await waitFor(() => expect(mocks.ops).toHaveLength(3));
  expect(askedTargets()).toEqual(["origin/feat-x"]);
  expect(forceOf(mocks.ops)).toEqual([
    ["/p/a", false],
    ["/p/b", true],
    ["/p/c", true],
  ]);
});

it("does not ask without Force", async () => {
  await openPushDialog();
  fireEvent.click(screen.getByRole("button", { name: "Push" }));

  await waitFor(() => expect(mocks.ops).toHaveLength(3));
  expect(mocks.ask).not.toHaveBeenCalled();
});

it("preselects the repositories that were committed before opening Push", async () => {
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ selected: ["/p/b"] }));
  expect(await screen.findByRole("checkbox", { name: "b" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "a" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "c" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops.map(({ repo }) => repo)).toEqual(["/p/b"]));
});

it("publishes a selected detached repository from the multi-repository dialog", async () => {
  const revision = "a".repeat(40);
  mocks.detached.set("/p/b", revision);
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ selected: ["/p/b"] }));

  expect(await screen.findByRole("checkbox", { name: "b" })).toBeChecked();
  expect(screen.getByTitle(`Detached HEAD at ${revision}`)).toHaveTextContent("aaaaaaaa");
  fireEvent.click(screen.getByRole("button", { name: /^Push$/ }));
  await waitFor(() =>
    expect(mocks.ops).toEqual([
      {
        repo: "/p/b",
        op: expect.objectContaining({
          op: "pushSelected",
          selection: { branch: null, revision, remote: "origin", target: "detached2" },
          set_upstream: false,
        }),
      },
    ]),
  );
});
