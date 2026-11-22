import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
const { apply, list, files, action, menu } = vi.hoisted(() => ({
  apply: vi.fn(),
  list: vi.fn(),
  files: vi.fn(),
  action: vi.fn(),
  menu: vi.fn(),
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
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: action,
}));
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  showContextMenu: menu,
}));
import { StashesPanel } from "../StashesPanel";
import { useProject } from "@/platform/project";
import { useCommit } from "../commitStore";
import { focusedStashDiff } from "../stashDiff";
import { useVcs } from "../store";

beforeEach(() => {
  useProject.setState({ settings: null });
  apply.mockReset();
  action.mockReset();
  menu.mockReset();
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
  useCommit.setState({ diffPreview: false });
});

it("lists stashes from every root and applies the selected row in its own repository", async () => {
  render(<StashesPanel />);
  expect(await screen.findByText("front · First")).toBeInTheDocument();
  expect(await screen.findByText("back · Second")).toBeInTheDocument();
  act(() => useVcs.setState({ repo: "/p/back" }));
  await screen.findByText("front · First");
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ index: 0, id: "/p/front-stash" }), false, "/p/front");
});

it("keeps the selected stash when a refresh inserts a new entry above it", async () => {
  render(<StashesPanel />);
  const original = await screen.findByText("front · First");
  fireEvent.mouseDown(original, { button: 0 });
  list.mockImplementation(async (repo: string) => ({
    status: "ok",
    data:
      repo === "/p/front"
        ? [
            { index: 0, message: "On main: New", timeMs: 1, id: "new", base: "/p/front-base" },
            { index: 1, message: "On main: First", timeMs: 0, id: "/p/front-stash", base: "/p/front-base" },
          ]
        : [],
  }));
  act(() => useVcs.setState((state) => ({ version: state.version + 1 })));
  expect(await screen.findByText("front · New")).toBeInTheDocument();
  expect(screen.getByText("front · First").closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ index: 1, id: "/p/front-stash" }), false, "/p/front");
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
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ index: 0, id: "n" }), false, "/other");
});

it("shows the selected stash's files and opens their diff without applying the stash", async () => {
  render(<StashesPanel />);
  fireEvent.mouseDown(await screen.findByText("back · Second"), { button: 0 });
  const file = await within(await screen.findByRole("tree", { name: "Changed files" })).findByText("app.ts");
  expect(files).toHaveBeenCalledWith("/p/back", "/p/back-stash");
  expect(apply).not.toHaveBeenCalled();
  fireEvent.doubleClick(file);
  expect(action).toHaveBeenCalledTimes(1);
  const [
    command,
    {
      changes: [change],
    },
  ] = action.mock.calls[0]!;
  expect(command).toBe("vcs.stash.showDiff");
  expect(change).toMatchObject({ path: "src/app.ts", before: "/p/back-base", after: "/p/back-stash" });
});

it("uses the separate saved revision for stashed untracked files", async () => {
  list.mockResolvedValueOnce({
    status: "ok",
    data: [{ index: 0, message: "On main: First", timeMs: 0, id: "stash", base: "base", untracked: "untracked" }],
  });
  files.mockImplementation(async (_repo, revision) => ({
    status: "ok",
    data: revision === "untracked" ? [{ path: "notes.txt", kind: "added", oldPath: null }] : [],
  }));
  render(<StashesPanel />);
  expect(await screen.findByText("Untracked Files")).toBeInTheDocument();
  fireEvent.doubleClick(await screen.findByText("notes.txt"));
  expect(files).toHaveBeenCalledWith("/p/front", "untracked");
  const [
    ,
    {
      changes: [change],
    },
  ] = action.mock.calls[0]!;
  expect(change).toMatchObject({ path: "notes.txt", before: null, after: "untracked", repo: "/p/front" });
});

it("routes Show Diff to the selected stash file while its tree has focus", async () => {
  render(<StashesPanel />);
  const file = await screen.findByText("app.ts");
  const tree = screen.getByRole("tree", { name: "Changed files" });
  fireEvent.focus(tree);
  fireEvent.mouseDown(file, { button: 0 });
  expect(focusedStashDiff()).toMatchObject({ index: 0, changes: [{ repo: "/p/front", after: "/p/front-stash" }] });
  fireEvent.blur(tree, { relatedTarget: document.body });
  expect(focusedStashDiff()).toBeNull();
});

it("passes a multi-file selection to diff, compare and apply actions", async () => {
  useProject.setState({ settings: { vcs: { git: { stashDiffTarget: "parent" } } } } as Parameters<
    typeof useProject.setState
  >[0]);
  files.mockResolvedValue({
    status: "ok",
    data: ["app.ts", "config.ts", "other.ts"].map((path) => ({ path, kind: "modified", oldPath: null })),
  });
  render(<StashesPanel />);
  const first = await screen.findByText("app.ts");
  const second = screen.getByText("config.ts");
  fireEvent.mouseDown(first, { button: 0 });
  fireEvent.mouseDown(second, { button: 0, shiftKey: true });

  fireEvent.click(screen.getByRole("button", { name: "Show Diff" }));
  const [command, { changes: selected, chain }] = action.mock.calls[0]!;
  expect(command).toBe("vcs.stash.showDiff");
  expect(selected.map((c: { path: string }) => c.path)).toEqual(["app.ts", "config.ts"]);
  expect(chain).toEqual(selected);
  fireEvent.contextMenu(first);
  expect(menu.mock.calls[0]![1]).toContainEqual(
    expect.objectContaining({
      action: "vcs.stash.compareWithLocal",
      arg: { index: 0, changes: selected, chain: selected },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply Selected Changes" }));
  expect(action).toHaveBeenCalledWith("vcs.log.changes.apply", selected);
  expect(apply).not.toHaveBeenCalled();
});

it("ignores stale file results when switching stashes", async () => {
  let resolve!: (value: unknown) => void;
  files.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<StashesPanel />);
  fireEvent.mouseDown(await screen.findByText("back · Second"), { button: 0 });
  expect(await screen.findByText("app.ts")).toBeInTheDocument();
  await act(async () => {
    resolve({ status: "ok", data: [{ path: "stale.ts", kind: "modified", oldPath: null }] });
  });
  expect(screen.queryByText("stale.ts")).not.toBeInTheDocument();
});
