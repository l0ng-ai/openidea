/**
 * Create New Branch: spaces typed or pasted into the name become separators on the fly, as in
 * IDEA, so the name stays valid. Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

async function openNewBranchDialog(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
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
    h.vcs_create_branch = () => null;
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    void executeAction("vcs.newBranch");
  }, ROOT);
  const dialog = page.getByRole("dialog", { name: "Create New Branch" });
  const input = dialog.getByRole("textbox", { name: "New branch name:" });
  await expect(input).toBeVisible();
  return { dialog, input };
}

test("a typed space becomes a separator and Create stays enabled", async ({ workbench: page }) => {
  const { dialog, input } = await openNewBranchDialog(page);
  await input.fill("");
  await input.pressSequentially("fix login  redirect");
  await expect(input).toHaveValue("fix-login-redirect");
  await expect(dialog.getByText("Branch name contains invalid characters")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const [call] = await ipcCalls(page, "vcs_create_branch");
  expect(call).toMatchObject({ name: "fix-login-redirect" });
});

test("a space typed in the middle keeps the caret after it", async ({ workbench: page }) => {
  const { input } = await openNewBranchDialog(page);
  await input.fill("ab");
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(1, 1));
  await page.keyboard.press("Space");
  await expect(input).toHaveValue("a-b");
  await page.keyboard.type("x");
  await expect(input).toHaveValue("a-xb");
});

test("pasted text has its spaces replaced", async ({ workbench: page }) => {
  const { dialog, input } = await openNewBranchDialog(page);
  await input.fill("");
  await input.evaluate((el: HTMLInputElement) => {
    el.focus();
    document.execCommand("insertText", false, "feature/add new thing");
  });
  await expect(input).toHaveValue("feature/add-new-thing");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
});
