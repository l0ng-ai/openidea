/**
 * Renaming a branch follows in the Git Log: the Branch filter chip keeps naming
 * the branch under its new name (and the remembered choice follows), instead of
 * filtering an unknown revision. Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

interface StubBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommitMs: number | null;
  commit: string;
}

/** Installs a two-branch repository (`sd` checked out) and opens the Git Log on `HEAD`. */
async function openLogOnSd(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
    const commits = Array.from({ length: 6 }, (_, i) => ({
      id: i.toString(16).padStart(40, "0"),
      shortId: i.toString(16).padStart(8, "0"),
      parents: i + 1 < 6 ? [(i + 1).toString(16).padStart(40, "0")] : [],
      refs: i === 0 ? ["HEAD", "sd"] : [],
      author: "Author",
      email: "author@example.com",
      timeMs: 20 - i,
      summary: `Commit ${i}`,
      message: `Commit ${i}`,
    }));
    let head = "sd";
    let branches: StubBranch[] = [
      {
        name: "sd",
        current: true,
        remote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 20,
        commit: commits[0]!.id,
      },
      {
        name: "main",
        current: false,
        remote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 20,
        commit: commits[5]!.id,
      },
    ];
    h.vcs_log = ({ query }) => {
      const { skip, limit } = query as { skip: number; limit: number };
      return commits.slice(skip, limit ? skip + limit : undefined);
    };
    h.vcs_log_refs = () => ({});
    h.vcs_log_users = () => ["Author <author@example.com>"];
    h.vcs_roots = () => [{ root, operation: null, head, headCommit: commits[0]!.id, hasRemotes: false }];
    h.vcs_branch_info = () => ({
      head,
      headCommit: commits[0]!.id,
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => [];
    h.vcs_branches = () => branches;
    h.vcs_stashes = () => [];
    h.vcs_tags = () => [];
    h.vcs_config_get = () => null;
    h.vcs_rename_branch = ({ from, to }) => {
      if (!branches.some((b) => !b.remote && b.name === from))
        throw { kind: "failed", message: "no such branch", detail: null };
      head = to;
      branches = branches.map((b) => (b.name === from ? { ...b, name: to } : b));
      return null;
    };
    h.vcs_commit_files = () => [];
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map(() => ({
        message: "",
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
    await loadBranches();
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  }, ROOT);
  await expect(page.getByRole("listbox", { name: "Commits" }).getByRole("option").first()).toBeVisible();
}

test("the log branch filter follows a branch rename from the log's own toolbar", async ({ workbench: page }) => {
  await openLogOnSd(page);
  const toolbar = page.getByRole("toolbar", { name: "Log filters", exact: true });
  // First open settles the filter on HEAD; the chip names it.
  await expect(toolbar.getByRole("button", { name: "Branch: HEAD", exact: true })).toBeVisible();

  // Choose the branch `sd` in the filter popup, as the user would.
  await toolbar.getByRole("button", { name: "Branch: HEAD", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Filter by Branch" });
  await expect(popup).toBeVisible();
  await popup.getByRole("option", { name: "Local", exact: true }).click();
  await popup.getByRole("option", { name: "sd", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Branch: sd", exact: true })).toBeVisible();

  // Rename the branch from its Branches pane context menu, as the user would.
  await page.getByRole("tree", { name: "Branches" }).getByRole("treeitem", { name: "sd current" }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  // The prompt dialog: type the new name and confirm.
  const dialog = page.getByRole("dialog", { name: "Rename Branch sd" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox");
  await field.fill("feature");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();

  // No error balloon (the old filter would produce "unknown revision sd").
  await expect(page.getByText(/unknown revision/)).toHaveCount(0);
  await expect
    .poll(() => ipcCalls(page, "vcs_rename_branch"))
    .toMatchObject([{ repo: ROOT, from: "sd", to: "feature" }]);

  // The chip follows the rename; the log reloads without an error row.
  await expect(toolbar.getByRole("button", { name: "Branch: feature", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Branch: sd", exact: true })).toHaveCount(0);
  await expect(page.getByText(/unknown revision/)).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Commits" }).getByRole("option").first()).toBeVisible();
});
