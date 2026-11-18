import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
const { apply, list, files, diff } = vi.hoisted(() => ({
  apply: vi.fn(),
  list: vi.fn(),
  files: vi.fn(),
  diff: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStashes: list,
      vcsCommitFiles: files,
    },
  };
});
vi.mock("../changeOps", async (original) => ({
  ...(await original<typeof import("../changeOps")>()),
  applyStash: apply,
}));
vi.mock("../logChanges", async (original) => ({
  ...(await original<typeof import("../logChanges")>()),
  showChangesDiff: diff,
}));
import { StashesPanel } from "../CommitView";
import { useVcs } from "../store";

beforeEach(() => {
  apply.mockReset();
  diff.mockReset().mockResolvedValue(undefined);
  files.mockReset().mockResolvedValue({
    status: "ok",
    data: [{ path: "src/app.ts", kind: "modified", oldPath: null }],
  });
  list.mockReset().mockImplementation((repo: string) =>
    Promise.resolve({
      status: "ok",
      data: [
        {
          index: 0,
          message: `On main: ${repo.endsWith("front") ? "First" : "Second"}`,
          timeMs: 0,
          id: `${repo}-stash`,
          base: `${repo}-base`,
        },
      ],
    }),
  );
  useVcs.setState({ root: "/p", roots: ["/p/front", "/p/back"], repo: "/p/front" });
});

it("lists stashes from every root and applies the selected row in its own repository", async () => {
  render(<StashesPanel />);
  expect(await screen.findByText("front · First")).toBeInTheDocument();
  expect(await screen.findByText("back · Second")).toBeInTheDocument();
  act(() => useVcs.setState({ repo: "/p/back" }));
  await screen.findByText("front · First");
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  expect(apply).toHaveBeenCalledWith(0, false, "/p/front");
});

it("disables stale stash actions while another repository is loading", async () => {
  render(<StashesPanel />);
  await screen.findByText("front · First");
  let resolve!: (value: unknown) => void;
  list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  act(() => useVcs.setState({ root: "/other", roots: ["/other"], repo: "/other" }));
  expect(screen.queryByText("front · First")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply Stash" })).toBeDisabled();
  await act(async () => {
    resolve({ status: "ok", data: [{ index: 0, message: "On main: New project", timeMs: 0, id: "n", base: "b" }] });
  });
  await screen.findByText("New project");
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  expect(apply).toHaveBeenCalledWith(0, false, "/other");
});

it("lists a stash's changed files and opens their diff instead of applying the stash", async () => {
  render(<StashesPanel />);
  const row = await screen.findByText("front · First");
  // Double-clicking a stash expands it; it never applies the stash.
  fireEvent.doubleClick(row);
  expect(await screen.findByText("app.ts")).toBeInTheDocument();
  expect(files).toHaveBeenCalledWith("/p/front", "/p/front-stash");
  expect(apply).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText("app.ts"));
  expect(diff).toHaveBeenCalledTimes(1);
  const [[change], preview] = diff.mock.calls[0]!;
  expect(preview).toBe(false);
  expect(change).toMatchObject({ path: "src/app.ts", before: "/p/front-base", after: "/p/front-stash" });
});
