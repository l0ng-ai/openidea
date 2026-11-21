import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Stash } from "@/bindings";

const mocks = vi.hoisted(() => ({
  stashes: new Map<string | null, Stash[]>(),
  drops: [] as Array<{ repo: string | null; index: number }>,
  diffs: [] as Array<{ repo: string | null; from: string; to: string }>,
  applies: [] as Array<{ repo: string | null; index: number }>,
  confirm: vi.fn(),
  beforeRead: vi.fn<(repo: string | null) => Promise<void>>(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStashes: async (repo: string | null) => {
        await mocks.beforeRead(repo);
        return ok(mocks.stashes.get(repo) ?? []);
      },
      vcsStashDrop: (repo: string | null, index: number) => {
        mocks.drops.push({ repo, index });
        const list = mocks.stashes.get(repo) ?? [];
        mocks.stashes.set(
          repo,
          list.filter((s) => s.index !== index).map((s) => (s.index > index ? { ...s, index: s.index - 1 } : s)),
        );
        return ok(null);
      },
      vcsStashApply: (repo: string | null, index: number) => {
        mocks.applies.push({ repo, index });
        return ok(null);
      },
      vcsDiffRevisions: (repo: string | null, from: string, to: string) => {
        mocks.diffs.push({ repo, from, to });
        return ok([{ path: "src/a.ts", kind: "modified", oldPath: null }]);
      },
    },
  };
});

vi.mock("../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));

import { VcsDialogHost } from "../dialogs";
import { showUnstashDialog } from "../changeOps";
import { useVcs } from "../store";

const stash = (index: number, message: string): Stash => ({ index, message, timeMs: null, id: `s${index}`, base: "b" });

beforeEach(() => {
  mocks.stashes = new Map([
    ["/p/a", [stash(0, "On main: a0")]],
    ["/p/b", [stash(0, "On dev: first"), stash(1, "On dev: second"), stash(2, "On dev: third")]],
  ]);
  mocks.drops = [];
  mocks.diffs = [];
  mocks.applies = [];
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

it("disables Show Changes and Drop Stash when there is no stash", async () => {
  mocks.stashes.set("/p/a", []);
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/a"));
  expect(await screen.findByText("No stashes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show Changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Drop Stash" })).toBeDisabled();
});

it("views the changes of the selected stash in the dialog's repository", async () => {
  render(<VcsDialogHost />);
  act(() => showUnstashDialog(0, "/p/b"));
  await screen.findByText("stash@{0}: On dev: first");
  fireEvent.click(radio("stash@{1}"));
  fireEvent.click(screen.getByRole("button", { name: "Show Changes" }));

  await waitFor(() => expect(mocks.diffs).toEqual([{ repo: "/p/b", from: "stash@{1}^", to: "stash@{1}" }]));
  expect(await screen.findByText(/Changes between stash@\{1\}\^ and stash@\{1\}/)).toBeInTheDocument();
  // The Unstash dialog stays open behind the changes, nothing applied or dropped.
  expect(screen.getByText("stash@{2}: On dev: third")).toBeInTheDocument();
  expect(mocks.applies).toEqual([]);
  expect(mocks.drops).toEqual([]);
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
