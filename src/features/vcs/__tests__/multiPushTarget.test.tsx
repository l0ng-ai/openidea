import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  failing: new Set<string>(),
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
        ok([{ id: `${repo}-1`, shortId: "c1", parents: ["c0"], summary: "Work", author: "me", timeMs: 0 }]),
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
  notes = [];
  useVcs.setState({ root: "/p", roots: ["/p/a", "/p/b", "/p/c"], repo: "/p/a", remoteBusy: null, available: false });
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

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
