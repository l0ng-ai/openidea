/**
 * Push dialog: the target branch field completes what is typed from the branches the
 * chosen remote already has, so an existing remote branch need not be spelled out in
 * full. Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const HUGE = `feature/wrap-${"x".repeat(140)}`;

async function openPushDialog(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => [];
    h.vcs_log = () => [];
    h.vcs_remotes = () => [{ name: "origin", url: "git@example.com:acme/api.git" }];
    const branch = (name: string, remote: boolean, upstream: string | null = null) => ({
      name,
      remote,
      current: !remote,
      upstream,
      ahead: 0,
      behind: 0,
      lastCommitMs: 0,
    });
    h.vcs_branches = () => [
      branch("main", false, "origin/main"),
      branch("feature/login", false),
      branch("origin/main", true),
      branch("origin/feature/login", true),
      branch("origin/fix/error-auth", true),
      branch("origin/feature/PLATFORM-12345-order-history-export", true),
      branch(`origin/feature/wrap-${"x".repeat(140)}`, true),
    ];
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    void executeAction("vcs.push");
  }, ROOT);
  const dialog = page.getByRole("dialog", { name: /Push/ });
  const input = dialog.getByRole("combobox", { name: "Target branch" });
  await expect(input).toBeVisible();
  return { dialog, input };
}

test("typing part of a remote branch name lists the matching branches", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("fo");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText([
    "feature/login",
    "fix/error-auth",
    "feature/PLATFORM-12345-order-history-export",
  ]);
});

test("picking a branch from the list fills the field in", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("error");
  await page.getByRole("option", { name: "fix/error-auth" }).click();
  await expect(input).toHaveValue("fix/error-auth");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toHaveCount(0);
});

test("a name the remote does not have stays usable as free text", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("release/3.0");
  await expect(page.getByText("No matching remote branches")).toBeVisible();
  await expect(input).toHaveValue("release/3.0");
});

test("a long branch name widens the list instead of being cut off", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("PLATFORM");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  const option = list.getByRole("option", { name: "feature/PLATFORM-12345-order-history-export" });
  await expect(option).toBeVisible();
  // The popup grew past the field's 220px, and the row shows its whole name.
  expect((await list.boundingBox())!.width).toBeGreaterThan(220);
  expect(
    await option.evaluate((el) => {
      const name = el.querySelector('[class*="targetName"]');
      return name ? name.scrollWidth > name.clientWidth + 1 : true;
    }),
  ).toBe(false);
});

test("an extremely long name is capped and keeps the full text as a tooltip", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("wrap");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  const option = list.getByRole("option", { name: HUGE });
  // The name is cut off, so the row carries it as a tooltip.
  await expect(option.getByTitle(HUGE)).toHaveCount(1);
  expect((await list.boundingBox())!.width).toBeLessThanOrEqual(640);
  expect(
    await option.evaluate((el) => {
      const name = el.querySelector('[class*="targetName"]');
      return name ? name.scrollWidth > name.clientWidth : false;
    }),
  ).toBe(true);
});

test("Escape closes the list but keeps the dialog", async ({ workbench: page }) => {
  const { dialog, input } = await openPushDialog(page);
  await input.fill("f");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toBeVisible();
  await input.press("Escape");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
