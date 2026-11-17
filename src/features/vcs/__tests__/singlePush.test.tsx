import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ log: vi.fn() }));

const commit = (id: string, summary: string) => ({
  id,
  shortId: id,
  parents: ["c0"],
  summary,
  message: summary,
  author: "me",
  email: "me@example.com",
  timeMs: 0,
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
      vcsRemotes: () => ok([{ name: "origin", fetchUrl: "/remotes/origin", pushUrl: "/remotes/origin" }]),
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
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showPushDialog } from "../remoteUi";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.log.mockReset();
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
