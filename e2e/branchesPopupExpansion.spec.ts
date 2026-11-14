/**
 * Git Branches keeps the groups the user expanded or collapsed after a restart, as IDEA does.
 * Git is stubbed at the IPC layer; reloading the page stands in for restarting the IDE.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

async function openBranches(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
    const branch = (name: string, remote: boolean, current = false) => ({
      name,
      current,
      remote,
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommitMs: null,
      commit: "1111111",
    });
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => [];
    h.vcs_tags = () => [];
    h.vcs_branches = () => [
      branch("main", false, true),
      branch("develop", false),
      branch("origin/main", true),
      branch("origin/release", true),
    ];
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
    await loadBranches();
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.branches");
  }, ROOT);
  const popup = page.getByRole("dialog", { name: "Git Branches" });
  await expect(popup.getByRole("listbox", { name: "Branches" })).toBeVisible();
  return popup;
}

const group = (popup: ReturnType<Page["getByRole"]>, label: string) =>
  popup.locator("[aria-expanded]").filter({ has: popup.page().getByText(label, { exact: true }) });

test("Git Branches reopens with the groups expanded as the user left them, also after a restart", async ({
  workbench: page,
}) => {
  let popup = await openBranches(page);
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "false");
  await group(popup, "Remote").click();
  await group(popup, "Local").click();
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "true");
  await expect(group(popup, "Local")).toHaveAttribute("aria-expanded", "false");
  await expect(popup.getByText("release", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  popup = await openBranches(page);
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "true");
  await expect(group(popup, "Local")).toHaveAttribute("aria-expanded", "false");
  await expect(popup.getByText("release", { exact: true })).toBeVisible();
  await expect(popup.getByText("develop", { exact: true })).toBeHidden();
});
