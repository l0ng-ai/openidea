import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  failing: new Set<string>(),
  upToDate: new Set<string>(),
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
      vcsBranchInfo: (repo: string) =>
        ok({ head: "feat-x", headCommit: "c1", upstream: "origin/feat-x", ahead: 1, behind: 0, operation: null, repo }),
      vcsRemotes: (repo: string) => ok(repo === "/p/b" ? [remote("origin"), remote("fork")] : [remote("origin")]),
      vcsLog: (repo: string) =>
        ok(
          mocks.upToDate.has(repo)
            ? []
            : [
                {
                  id: `${repo}-1`,
                  shortId: "c1",
                  parents: ["c0"],
                  summary: "Work",
                  message: "Work",
                  author: "me",
                  email: "me@example.com",
                  timeMs: 0,
                },
              ],
        ),
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
import { VcsDialogHost } from "../dialogs";
import { showPushDialog } from "../remoteUi";
import { useVcs } from "../store";

type Note = { title: string; body?: string };
let notes: Note[] = [];

beforeEach(() => {
  mocks.ops = [];
  mocks.failing = new Set();
  mocks.upToDate = new Set();
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

it("pushes each repository to its own remote and target branch, reporting the one that failed", async () => {
  mocks.failing.add("/p/b");
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  const targetOfA = await screen.findByRole("textbox", { name: "Target branch of a" });
  expect(targetOfA).toHaveValue("feat-x");
  expect(screen.getByRole("checkbox", { name: "Push tags:" })).toBeInTheDocument();
  fireEvent.change(targetOfA, { target: { value: "release-2.1" } });
  // A retargeted push carries no tags, as in the single-repository dialog.
  expect(screen.queryByRole("checkbox", { name: "Push tags:" })).toBeNull();

  // Only a repository with several remotes offers to pick one.
  expect(screen.queryByRole("button", { name: "Remote of a" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remote of b" }));
  fireEvent.click(await screen.findByRole("option", { name: "fork" }));

  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(3));

  expect(mocks.ops).toEqual([
    {
      repo: "/p/a",
      op: {
        op: "pushBranch",
        branch: "feat-x",
        revision: null,
        force_with_lease: false,
        target: "release-2.1",
        remote: null,
        set_upstream: false,
        no_verify: false,
      },
    },
    {
      repo: "/p/b",
      op: {
        op: "pushBranch",
        branch: "feat-x",
        revision: null,
        force_with_lease: false,
        target: null,
        remote: "fork",
        set_upstream: false,
        no_verify: false,
      },
    },
    {
      repo: "/p/c",
      op: { op: "push", force_with_lease: false, set_upstream: false, tags: null, no_verify: false },
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
  await screen.findByRole("textbox", { name: "Target branch of a" });
}

it("lists every repository on Push all, checks those with commits, expands none and shows no files", async () => {
  mocks.upToDate.add("/p/c");
  render(<VcsDialogHost />);
  await act(() => showPushDialog());

  await screen.findByRole("textbox", { name: "Target branch of a" });
  expect(screen.getByRole("textbox", { name: "Target branch of c" })).toBeInTheDocument();
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
  expect(screen.getByRole("textbox", { name: "Target branch of b" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Target branch of a" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Target branch of c" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "b" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]?.repo).toBe("/p/b");
});

it("pushes an up-to-date repository from its own Push… to another target branch", async () => {
  mocks.upToDate.add("/p/b");
  render(<VcsDialogHost />);
  await act(() => showPushDialog({ repo: "/p/b" }));

  const target = await screen.findByRole("textbox", { name: "Target branch of b" });
  expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
  fireEvent.change(target, { target: { value: "release" } });
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]?.repo).toBe("/p/b");
});

it("asks to confirm each forced target and pushes nothing when one is declined", async () => {
  mocks.ask.mockResolvedValueOnce({ button: "force", checked: false }).mockResolvedValueOnce({ button: null });
  await openPushDialog();
  fireEvent.change(screen.getByRole("textbox", { name: "Target branch of a" }), { target: { value: "feat-a" } });
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
  fireEvent.change(screen.getByRole("textbox", { name: "Target branch of a" }), { target: { value: "main" } });
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
