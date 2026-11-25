import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  pushes: [] as Array<{ repo: string | null; message: string | null; paths: string[] | null }>,
  defaults: vi.fn(),
  status: vi.fn(),
  notify: vi.fn(),
  failRepo: null as string | null,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStatus: () => ok(mocks.status()),
      vcsBranchInfo: (repo: string | null) =>
        ok({
          head: repo === "/p/b" ? "dev" : "main",
          headCommit: "c1",
          upstream: null,
          ahead: 0,
          behind: 0,
          operation: null,
        }),
      vcsStashPush: (
        repo: string | null,
        message: string | null,
        untracked: boolean,
        keepIndex: boolean,
        paths: string[] | null,
      ) => {
        mocks.pushes.push({ repo, message, paths });
        mocks.defaults(repo, untracked, keepIndex);
        if (repo && repo === mocks.failRepo) return Promise.reject(new Error("Merge conflict"));
        return ok(null);
      },
      vcsStashes: () => ok([]),
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { provideNotificationService } from "@/workbench/contributions";
import { stashChanges, stashSilently } from "../changeOps";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.pushes = [];
  mocks.failRepo = null;
  mocks.defaults.mockClear();
  mocks.status.mockReset();
  mocks.notify.mockClear();
  provideNotificationService({ notify: mocks.notify });
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
  });
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  let done!: Promise<void>;
  act(() => {
    done = stashChanges();
  });
  expect(await screen.findByText("Current branch: main")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Create Stash" }));
  await done;
  expect(mocks.pushes).toEqual([{ repo: null, message: null, paths: null }]);
});

it("stashes the repository picked in the dialog and shows its branch", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<void>;
  act(() => {
    done = stashChanges();
  });
  expect(await screen.findByText("Current branch: main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "wip b" } });
  await pick("Repository", "b");
  expect(await screen.findByText("Current branch: dev")).toBeInTheDocument();
  expect(screen.queryByText("Current branch: main")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Create Stash" }));
  await done;
  expect(mocks.pushes).toEqual([{ repo: "/p/b", message: "wip b", paths: null }]);
});

it("starts on the repository it was given and can switch back", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<void>;
  act(() => {
    done = stashChanges([], "/p/b");
  });
  expect(await screen.findByText("Current branch: dev")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("b");

  await pick("Repository", "a");
  expect(await screen.findByText("Current branch: main")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create Stash" }));
  await done;
  expect(mocks.pushes).toEqual([{ repo: "/p/a", message: null, paths: null }]);
});

it("offers no repository choice when stashing selected files, which pick their own repositories", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<void>;
  act(() => {
    done = stashChanges(["/p/a/x.ts", "/p/b/y.ts"]);
  });
  expect(await screen.findByText("Current branch: main")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Create Stash" }));
  await done;
  expect(mocks.pushes).toEqual([{ repo: "/p/a", message: null, paths: ["/p/a/x.ts", "/p/b/y.ts"] }]);
});

it("stashes nothing when cancelled after picking another repository", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<void>;
  act(() => {
    done = stashChanges();
  });
  await pick("Repository", "b");
  expect(await screen.findByText("Current branch: dev")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await done;
  await waitFor(() => expect(screen.queryByRole("button", { name: "Repository" })).toBeNull());
  expect(mocks.pushes).toEqual([]);
});

it("silently stashes every changed root, skips untracked-only and conflicted roots, and continues after an error", async () => {
  useVcs.setState({ roots: ["/p/a", "/p/a/nested", "/p/b", "/p/c"], status: [] });
  mocks.failRepo = "/p/a/nested";
  mocks.status.mockReturnValue([
    { path: "/p/a/conflict", staged: "conflicted", unstaged: "conflicted" },
    { path: "/p/a/edited", staged: null, unstaged: "modified" },
    { path: "/p/a/nested/staged", staged: "modified", unstaged: null },
    { path: "/p/b/new", staged: null, unstaged: "untracked" },
    { path: "/p/c/edited", staged: null, unstaged: "modified" },
  ]);
  await stashSilently();

  expect(mocks.pushes).toEqual([
    { repo: "/p/a/nested", message: null, paths: null },
    { repo: "/p/c", message: null, paths: null },
  ]);
  expect(mocks.defaults.mock.calls).toEqual([
    ["/p/a/nested", false, false],
    ["/p/c", false, false],
  ]);
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "Merge conflict" }));
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Changes stashed",
      body: "c",
      actions: [expect.objectContaining({ label: "Show Stashes" })],
    }),
  );
});
