import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MergeOptions, MergeOutcome } from "@/bindings";

const mocks = vi.hoisted(() => ({
  merges: [] as Array<{ repo: string | null; branches: string[]; options: MergeOptions }>,
  gitVersion: "git version 2.49.0.windows.1",
  outcome: { kind: "done" } as MergeOutcome,
  reportIncoming: false,
  openLogTab: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const head = (repo: string | null) => (repo === "/p/b" ? "dev" : "main");
  const local = (repo: string | null) =>
    repo === "/p/b"
      ? ["dev", "feature-b", "shared"]
      : ["main", "feature-a", "shared", "feature/REQ-126-明细汇总多选", "develop"];
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string | null) =>
        ok({ head: head(repo), headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null }),
      vcsBranches: (repo: string | null) =>
        ok(local(repo).map((name) => ({ name, remote: false, current: name === head(repo), commit: `tip-${name}` }))),
      vcsMergeBase: (repo: string | null, _head: string, tip: string) =>
        ok(
          mocks.reportIncoming && tip === "refs/heads/feature-a" && mocks.merges.length
            ? "incoming"
            : repo === "/p/a" && tip === "tip-shared"
              ? tip
              : "base",
        ),
      vcsDiffRevisions: () => ok([{ path: "incoming.txt" }]),
      vcsLog: () => ok([{ id: "incoming", summary: "Incoming commit" }]),
      vcsGitVersion: () => ok({ version: mocks.gitVersion, path: "git" }),
      vcsMergeWith: (repo: string | null, branches: string[], options: MergeOptions) => {
        mocks.merges.push({ repo, branches, options });
        return ok(mocks.outcome);
      },
    },
  };
});

vi.mock("../logStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logStore")>()),
  openLogTab: mocks.openLogTab,
}));

import { VcsDialogHost } from "../dialogs";
import { showMergeDialog } from "../gitMenuDialogs";
import { useVcs } from "../store";
import { provideNotificationService, provideToolWindowService } from "@/workbench/contributions";

const notify = vi.fn();

beforeEach(() => {
  mocks.merges = [];
  mocks.outcome = { kind: "done" };
  mocks.reportIncoming = false;
  mocks.openLogTab.mockClear();
  notify.mockClear();
  provideNotificationService({ notify });
  provideToolWindowService({ show: vi.fn(), hide: vi.fn(), toggle: vi.fn(), isVisible: () => false });
  mocks.gitVersion = "git version 2.49.0.windows.1";
  localStorage.removeItem("openidea.vcs.mergeOptions:/p");
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
  });
});

afterEach(() => {
  for (const button of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(button);
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  await pick("Branch to merge", "feature-a");
  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ repo: null, branches: ["refs/heads/feature-a"] });
});

it("offers to review blockers from the Merge dialog without starting Smart Merge", async () => {
  mocks.outcome = { kind: "localChanges", files: ["blocking.txt"] };
  render(<VcsDialogHost />);
  await act(() => showMergeDialog("/p/a"));
  await pick("Branch to merge", "feature-a");
  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Merge failed" })));
  const action = notify.mock.calls.find(([n]) => n.title === "Merge failed")?.[0].actions[0];
  expect(action.label).toBe("View Files…");
  await act(() => action.run());
  expect(await screen.findByRole("dialog", { name: "Local Changes Prevent Merge" })).toBeInTheDocument();
  expect(screen.getByText("blocking.txt")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Smart Merge" })).toBeNull();
  expect(mocks.merges).toHaveLength(1);
  fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
});

it("offers the incoming commit range from the repository that was merged", async () => {
  mocks.reportIncoming = true;
  render(<VcsDialogHost />);
  await act(() => showMergeDialog("/p/a"));
  await pick("Branch to merge", "feature-a");
  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "1 file updated in 1 commit" })),
  );
  const notice = notify.mock.lastCall?.[0];
  expect(notice.actions[0].label).toBe("View Commits");
  await act(async () => notice.actions[0].run());
  await waitFor(() =>
    expect(mocks.openLogTab).toHaveBeenCalledExactlyOnceWith("update", expect.any(String), "toolWindow", ["/p/a"], {
      repoRanges: { "/p/a": "base..incoming" },
    }),
  );
});

it.each([
  ["alreadyUpToDate", "All files are up to date", undefined],
  ["readyToCommit", "Merge is ready to commit", "Commit…"],
  ["squashed", "Squash merge is ready to commit", "Commit…"],
] as const)("reports an explicit merge that is %s", async (kind, title, action) => {
  mocks.outcome = { kind };
  render(<VcsDialogHost />);
  await act(() => showMergeDialog("/p/a"));
  await pick("Branch to merge", "feature-a");
  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title })));
  expect(notify.mock.lastCall?.[0].actions?.[0]?.label).toBe(action);
});

it("merges into the repository picked in the dialog, offering that repository's branches", async () => {
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Repository", "b");
  expect(await screen.findByText("Merge into dev")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Branch to merge" }));
  expect(await screen.findByRole("option", { name: "feature-b" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "feature-a" })).toBeNull();
  // The current branch of the picked repository is not offered.
  expect(screen.queryByRole("option", { name: "dev" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "feature-b" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ repo: "/p/b", branches: ["refs/heads/feature-b"] });
});

it("rechecks the same selected branch tip against the new repository's HEAD", async () => {
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();

  await pick("Branch to merge", "shared");
  expect(await screen.findByText("Branch 'shared' is already merged.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();

  await pick("Repository", "b");
  expect(await screen.findByText("Merge into dev")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Branch to merge" })).toHaveTextContent("shared"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  expect(screen.queryByText("Branch 'shared' is already merged.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges[0]).toMatchObject({ repo: "/p/b", branches: ["refs/heads/shared"] }));
});

it("filters the branch list as the user types and picks the top match with Enter", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();

  // Typing on the closed picker opens it with that text as the search.
  const trigger = screen.getByRole("button", { name: "Branch to merge" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "1" });
  const search = await screen.findByRole("textbox");
  expect(search).toHaveValue("1");
  for (const query of ["126", "明细", "req"]) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["feature/REQ-126-明细汇总多选"]);
  }
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger).toHaveTextContent("feature/REQ-126-明细汇总多选");
  // Enter chose the branch; it did not also run the dialog's Merge button.
  expect(mocks.merges).toEqual([]);

  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ branches: ["refs/heads/feature/REQ-126-明细汇总多选"] });
});

it("sends compatible options and restores them and the branch only after confirming", async () => {
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  await pick("Branch to merge", "feature-a");

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Modify options" }));
  const flag = (name: string) => screen.findByRole("menuitemcheckbox", { name });
  open();
  fireEvent.click(await flag("--allow-unrelated-histories"));
  open();
  fireEvent.click(await flag("--no-verify"));
  open();
  fireEvent.click(await flag("-m (commit message)"));
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Join histories" } });
  open();
  expect(await flag("--ff-only")).toHaveAttribute("aria-disabled", "true");
  expect(await flag("--squash")).toHaveAttribute("aria-disabled", "true");
  expect(await flag("--no-commit")).toHaveAttribute("aria-disabled", "true");
  expect(await flag("--no-ff")).not.toHaveAttribute("aria-disabled", "true");
  fireEvent.click(await flag("--no-ff"));

  await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() =>
    expect(mocks.merges[0]).toMatchObject({
      branches: ["refs/heads/feature-a"],
      options: { noFf: true, noVerify: true, allowUnrelatedHistories: true, message: "Join histories" },
    }),
  );

  await act(() => showMergeDialog());
  await waitFor(() => expect(screen.getByRole("button", { name: "Branch to merge" })).toHaveTextContent("feature-a"));
  expect(screen.getByRole("group", { name: "Merge options" })).toHaveTextContent("--allow-unrelated-histories");
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("");
  open();
  fireEvent.click(await flag("--allow-unrelated-histories"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await act(() => showMergeDialog());
  expect(screen.getByRole("group", { name: "Merge options" })).toHaveTextContent("--allow-unrelated-histories");
});
