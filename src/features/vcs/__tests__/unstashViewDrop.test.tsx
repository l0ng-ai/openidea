import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Stash } from "@/bindings";
import { setContext } from "@/platform/context";
import { installKeyboardDispatcher, primaryKeyBinding } from "@/platform/keymap";
import { useProject } from "@/platform/project";

const mocks = vi.hoisted(() => ({
  stashes: new Map<string | null, Stash[]>(),
  drops: [] as Array<{ repo: string | null; index: number }>,
  clears: [] as Array<string | null>,
  compared: [] as Array<{ repo: string | null; revision: string }>,
  applies: [] as Array<{ repo: string | null; index: number }>,
  confirm: vi.fn(),
  openDiff: vi.fn(),
  beforeRead: vi.fn<(repo: string | null) => Promise<void>>(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const findIndex = (repo: string | null, stash: Stash) =>
    mocks.stashes.get(repo)?.find((entry) => entry.id === stash.id)?.index;
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStashes: async (repo: string | null) => {
        await mocks.beforeRead(repo);
        return ok(mocks.stashes.get(repo) ?? []);
      },
      vcsStashDrop: (repo: string | null, stash: Stash) => {
        const index = findIndex(repo, stash);
        if (index === undefined) {
          return Promise.resolve({
            status: "error",
            error: { kind: "invalidInput", message: "The selected stash is no longer available" },
          });
        }
        mocks.drops.push({ repo, index });
        const list = mocks.stashes.get(repo) ?? [];
        mocks.stashes.set(
          repo,
          list.filter((s) => s.index !== index).map((s) => (s.index > index ? { ...s, index: s.index - 1 } : s)),
        );
        return ok(index);
      },
      vcsStashApply: (repo: string | null, stash: Stash) => {
        const index = findIndex(repo, stash)!;
        mocks.applies.push({ repo, index });
        return ok({ index, outcome: { kind: "done" } });
      },
      vcsStashClear: (repo: string | null) => {
        mocks.clears.push(repo);
        mocks.stashes.set(repo, []);
        return ok(null);
      },
      vcsCommitFiles: (repo: string | null, revision: string) => {
        mocks.compared.push({ repo, revision });
        return ok(
          revision === "extra"
            ? [{ path: "notes.txt", kind: "added", oldPath: null }]
            : [{ path: "src/a.ts", kind: "modified", oldPath: null }],
        );
      },
      fsEntryKind: () => ok("file"),
    },
  };
});

vi.mock("../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));
vi.mock("../diffDialog", () => ({ openDiffDialog: mocks.openDiff }));

import { registerVcsActions } from "../actions";
import { VcsDialogHost } from "../dialogs";
import { showUnstashAsDialog, showUnstashDialog } from "../changeOps";
import { useVcs } from "../store";

const stash = (index: number, message: string): Stash => ({ index, message, timeMs: null, id: `s${index}`, base: "b" });

beforeEach(() => {
  mocks.stashes = new Map([
    ["/p/a", [stash(0, "On main: a0")]],
    ["/p/b", [stash(0, "On dev: first"), stash(1, "On dev: second"), stash(2, "On dev: third")]],
  ]);
  mocks.drops = [];
  mocks.clears = [];
  mocks.compared = [];
  mocks.applies = [];
  mocks.openDiff.mockClear();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.beforeRead.mockReset().mockResolvedValue(undefined);
  useVcs.setState({ root: "/p", roots: ["/p/a", "/p/b"], repo: "/p/a", available: false });
});

afterEach(() => {
  // Dialogs live in a module store: close what a test left open.
  for (let open = screen.queryAllByRole("dialog"); open.length; open = screen.queryAllByRole("dialog")) {
    const before = open.length;
    fireEvent.keyDown(open[open.length - 1]!, { key: "Escape" });
    if (screen.queryAllByRole("dialog").length === before) break;
  }
});

const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(name.replace(/[{}@]/g, "\\$&")) });

it("applies the chosen stash in its repository after its index changes", async () => {
  const list = mocks.stashes.get("/p/b")!;
  render(<VcsDialogHost />);
  act(() => showUnstashAsDialog(list[1]!, "/p/b"));
  expect(screen.getByRole("dialog", { name: "Unstash Changes in b" })).toBeInTheDocument();
  expect(screen.getByText("On dev: second")).toBeInTheDocument();
  expect(screen.queryByRole("radio")).toBeNull();
  mocks.stashes.set("/p/b", [
    { ...list[1]!, index: 0 },
    { ...list[2]!, index: 1 },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  await waitFor(() => expect(mocks.applies).toEqual([{ repo: "/p/b", index: 0 }]));
});

it("clears only the dialog's repository after confirmation", async () => {
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/b"));
  const clear = screen.getByRole("button", { name: "Clear Stashes…" });
  await screen.findByText("stash@{0}: On dev: first");
  mocks.confirm.mockResolvedValueOnce(false);
  fireEvent.click(clear);
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.clears).toEqual([]);

  fireEvent.click(clear);
  expect(await screen.findByText("No stashes")).toBeInTheDocument();
  expect(mocks.clears).toEqual(["/p/b"]);
  expect(mocks.stashes.get("/p/a")).toHaveLength(1);
  expect(clear).toBeDisabled();
});

it("chooses a repository in the Unstash dialog and applies its selected stash", async () => {
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/a"));
  expect(await screen.findByText("stash@{0}: On main: a0")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(screen.getByRole("option", { name: "b" }));
  expect(screen.queryByText("stash@{0}: On main: a0")).toBeNull();
  expect(await screen.findByText("stash@{1}: On dev: second")).toBeInTheDocument();
  fireEvent.click(radio("stash@{1}"));
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  await waitFor(() => expect(mocks.applies).toEqual([{ repo: "/p/b", index: 1 }]));
});

it("disables Show Changes and Drop Stash when there is no stash", async () => {
  mocks.stashes.set("/p/a", []);
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/a"));
  expect(await screen.findByText("No stashes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show Changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Drop Stash" })).toBeDisabled();
});

it("reviews the selected stash against local files and returns to the unstash options", async () => {
  const previousSettings = useProject.getState().settings;
  useProject.setState({
    settings: { vcs: { git: { stashDiffTarget: "parent" } } },
  } as Parameters<typeof useProject.setState>[0]);
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  const uninstallKeyboard = installKeyboardDispatcher();
  try {
    const list = mocks.stashes.get("/p/b")!;
    list[1] = { ...list[1]!, untracked: "extra" };
    render(<VcsDialogHost />);
    act(() => showUnstashDialog(0, "/p/b"));
    await screen.findByText("stash@{0}: On dev: first");
    fireEvent.click(radio("stash@{1}"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pop stash" }));
    mocks.stashes.set(
      "/p/b",
      [list[0]!, list[2]!, list[1]!].map((entry, index) => ({ ...entry, index })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show Changes" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Paths Affected by stash@{1}" }));
    const file = await dialog.findByText("a.ts");
    expect(dialog.getByText("notes.txt")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Apply Selected Changes" })).toBeNull();
    expect(mocks.compared).toEqual([
      { repo: "/p/b", revision: "s1" },
      { repo: "/p/b", revision: "extra" },
    ]);
    const tree = dialog.getByRole("tree", { name: "Changed files" });
    const binding = primaryKeyBinding("vcs.showDiff");
    expect(binding).toMatch(/^(Meta|Ctrl)\+D$/);
    fireEvent.mouseDown(file, { button: 0 });
    fireEvent.keyDown(tree, {
      key: "d",
      code: "KeyD",
      metaKey: binding === "Meta+D",
      ctrlKey: binding === "Ctrl+D",
    });
    await waitFor(() =>
      expect(mocks.openDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/p/b/src/a.ts",
          left: { type: "worktree", label: "Local Version" },
          right: { type: "rev", rev: "s1", label: "stash@{1}" },
          chain: [
            expect.objectContaining({ path: "/p/b/src/a.ts" }),
            expect.objectContaining({ path: "/p/b/notes.txt", right: expect.objectContaining({ rev: "extra" }) }),
          ],
        }),
      ),
    );
    fireEvent.doubleClick(file);
    await waitFor(() => expect(mocks.openDiff).toHaveBeenCalledTimes(2));
    fireEvent.click(dialog.getByText("Close", { selector: "button" }));
    expect(radio("stash@{1}")).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pop stash" })).toBeChecked();
    expect(mocks.applies).toEqual([]);
    expect(mocks.drops).toEqual([]);
  } finally {
    uninstallKeyboard();
    unregister();
    setContext("vcsAvailable", false);
    useProject.setState({ settings: previousSettings });
  }
});

it("drops the selected stash after confirming, refreshes the list and selects the next one", async () => {
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/b"));
  await screen.findByText("stash@{0}: On dev: first");
  fireEvent.click(radio("stash@{1}"));
  fireEvent.click(screen.getByRole("button", { name: "Drop Stash" }));

  await waitFor(() => expect(mocks.drops).toEqual([{ repo: "/p/b", index: 1 }]));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Drop Stash", danger: true }));
  await waitFor(() => expect(screen.queryByText("stash@{1}: On dev: second")).toBeNull());
  // The older stash moved up into the dropped one's place and is selected.
  expect(screen.getByText("stash@{1}: On dev: third")).toBeInTheDocument();
  expect(radio("stash@{1}")).toBeChecked();
  expect(radio("stash@{0}")).not.toBeChecked();

  // The dialog stays open and acts on the refreshed list.
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  await waitFor(() => expect(mocks.applies).toEqual([{ repo: "/p/b", index: 1 }]));
});

it("selects the new last stash after dropping the last one, and disables both when none is left", async () => {
  mocks.stashes.set("/p/b", [stash(0, "On dev: first"), stash(1, "On dev: second")]);
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(1, "/p/b"));
  await screen.findByText("stash@{1}: On dev: second");
  expect(radio("stash@{1}")).toBeChecked();

  let finishRefresh = () => {};
  const refresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  mocks.beforeRead.mockImplementation((repo) => (repo === "/p/b" ? refresh : Promise.resolve()));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Drop Stash" }));
    await waitFor(() => expect(mocks.beforeRead.mock.calls.filter(([repo]) => repo === "/p/b")).toHaveLength(2));
    expect(screen.getByText("stash@{1}: On dev: second")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply Stash" })).toBeDisabled();
  } finally {
    mocks.beforeRead.mockResolvedValue(undefined);
    finishRefresh();
  }
  await waitFor(() => expect(screen.queryByText("stash@{1}: On dev: second")).toBeNull());
  expect(radio("stash@{0}")).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "Drop Stash" }));
  expect(await screen.findByText("No stashes")).toBeInTheDocument();
  expect(mocks.drops).toEqual([
    { repo: "/p/b", index: 1 },
    { repo: "/p/b", index: 0 },
  ]);
  expect(screen.getByRole("button", { name: "Show Changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Drop Stash" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Apply Stash" })).toBeDisabled();
});

it("keeps the stash when the drop is not confirmed", async () => {
  mocks.confirm.mockResolvedValue(false);
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/a"));
  await screen.findByText("stash@{0}: On main: a0");
  fireEvent.click(screen.getByRole("button", { name: "Drop Stash" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.drops).toEqual([]);
  expect(screen.getByText("stash@{0}: On main: a0")).toBeInTheDocument();
  expect(radio("stash@{0}")).toBeChecked();
});

it("drops the confirmed stash when another entry moved it to a different index", async () => {
  let answer!: (confirmed: boolean) => void;
  mocks.confirm.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/a"));
  const selected = mocks.stashes.get("/p/a")![0]!;
  await screen.findByText("stash@{0}: On main: a0");
  fireEvent.click(screen.getByRole("button", { name: "Drop Stash" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  mocks.stashes.set("/p/a", [
    { ...stash(0, "On main: newly stashed"), id: "newer" },
    { ...selected, index: 1 },
  ]);
  await act(async () => answer(true));
  expect(await screen.findByText("stash@{0}: On main: newly stashed")).toBeInTheDocument();
  expect(screen.queryByText(/On main: a0/)).toBeNull();
  expect(radio("stash@{0}")).toBeChecked();
  expect(mocks.drops).toEqual([{ repo: "/p/a", index: 1 }]);
});
