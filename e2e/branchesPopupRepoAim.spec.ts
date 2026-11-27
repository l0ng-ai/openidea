/**
 * Git Branches of a project with several repositories: the current repository is listed first,
 * and moving the pointer from a repository row toward its open branch list keeps that list open
 * while it crosses the other repository rows (like a submenu of a menu). Git is stubbed at the
 * IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const ROOTS = ["/dev/acme/app", "/dev/acme/lib", "/dev/acme/tools", "/dev/acme/web"];

async function openBranches(page: Page) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ roots }) => {
      const h = window.__ipc.handlers;
      const branch = (name: string, current = false) => ({
        name,
        current,
        remote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: null,
        commit: "1111111",
      });
      const repoName = (root: string) => root.split("/").pop()!;
      h.vcs_roots = () =>
        roots.map((root) => ({ root, operation: null, head: "main", headCommit: "1111111", hasRemotes: false }));
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
      h.vcs_branches = (args: { repo?: string | null }) => [
        branch("main", true),
        branch(`only-${repoName(args?.repo ?? roots[0]!)}`),
      ];
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ vcsModule);
      // The window works on the third repository.
      useVcs.setState({ available: true, root: roots[0], repo: roots[2], branchesLoaded: false });
      await refreshNow();
      await loadBranches();
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("vcs.branches");
    },
    { roots: ROOTS },
  );
  const list = page.getByRole("listbox", { name: "Repositories and branches" });
  await expect(list).toBeVisible();
  return list;
}

const center = async (locator: ReturnType<Page["locator"]>) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

test("multi-repository Git Branches lists the current repository first and keeps a branch list open on the way to it", async ({
  workbench: page,
}) => {
  const list = await openBranches(page);
  const rows = list.getByRole("option").filter({ has: page.locator("[data-row-key^='repo:']") });
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("tools");

  // Open the first repository's branches, then head diagonally into the list across the rows below.
  const first = await center(rows.nth(0));
  await page.mouse.move(first.x, first.y);
  const branchesOfTools = page.getByRole("dialog", { name: "Branches of tools" });
  await expect(branchesOfTools).toBeVisible();
  const target = (await branchesOfTools.boundingBox())!;
  const last = await center(rows.nth(3));
  await page.mouse.move(target.x + 12, last.y, { steps: 12 });
  await expect(branchesOfTools).toBeVisible();
  await expect(branchesOfTools.getByText("only-tools", { exact: true })).toBeVisible();

  // Moving straight onto another repository row switches to its branches.
  const second = await center(rows.nth(1));
  await page.mouse.move(second.x - 40, second.y);
  await page.mouse.move(second.x - 60, second.y);
  const branchesOfApp = page.getByRole("dialog", { name: "Branches of app" });
  await expect(branchesOfApp).toBeVisible();
  await expect(branchesOfTools).toBeHidden();

  // Stopping on a row while heading for the open list switches only after a short delay.
  const third = await center(rows.nth(2));
  const appList = (await branchesOfApp.boundingBox())!;
  await page.mouse.move(appList.x - 30, second.y);
  await page.mouse.move(appList.x - 6, third.y);
  await expect(branchesOfApp).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Branches of lib" })).toBeVisible();
  await expect(branchesOfApp).toBeHidden();
});
