/**
 * Create New Branch: spaces typed or pasted into the name become separators on the fly, as in
 * IDEA, so the name stays valid. Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

async function openNewBranchDialog(
  page: Page,
  from?: string,
  mergeBase = "1111111",
  blocked: boolean | string = false,
  withPrefix = false,
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, from, mergeBase, blocked, withPrefix }) => {
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
      h.vcs_branches = () => [
        {
          name: "main",
          current: true,
          remote: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          lastCommitMs: null,
          commit: "1111111",
        },
        ...(withPrefix ? [{ name: "feature/weekly-totals", current: false, remote: false }] : []),
      ];
      h.vcs_create_branch = ({ options }) =>
        blocked && (options as { mode?: string } | null)?.mode === "normal"
          ? {
              checkout: { kind: "localChanges", files: [typeof blocked === "string" ? blocked : "dirty.txt"] },
              created: null,
            }
          : { checkout: { kind: "done" }, created: { tip: "2222222", previousTip: null } };
      h.vcs_merge_base = () => mergeBase;
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
      await loadBranches();
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      if (from) void executeAction("vcs.log.newBranch", { id: from, summary: "Selected commit", repo: root });
      else void executeAction("vcs.newBranch");
    },
    { root: ROOT, from, mergeBase, blocked, withPrefix },
  );
  const dialog = page.getByRole("dialog", { name: from ? `Create New Branch from ${from}` : "Create New Branch" });
  const input = dialog.getByRole(withPrefix ? "combobox" : "textbox", { name: "New branch name:" });
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

test("overwrites a local branch only after explicitly opting in", async ({ workbench: page }) => {
  const from = "2".repeat(40);
  const { dialog, input } = await openNewBranchDialog(page, from);
  await input.fill("main");
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeDisabled();
  const overwrite = dialog.getByRole("checkbox", { name: "Overwrite existing branch" });
  await expect(overwrite).toBeVisible();
  await expect(overwrite).not.toBeChecked();
  await overwrite.check();
  await expect(create).toBeEnabled();
  await input.fill("new-branch");
  await expect(overwrite).toHaveCount(0);
  await input.fill("main");
  await expect(overwrite).not.toBeChecked();
  await expect(create).toBeDisabled();
  await overwrite.check();
  await create.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_create_branch"))
    .toMatchObject([
      { repo: ROOT, name: "main", start: from, checkout: true, overwrite: true, expectedTip: "1111111" },
    ]);
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

test("cancelling the drop-local-commits prompt keeps the branch intact", async ({ workbench: page }) => {
  const { dialog, input } = await openNewBranchDialog(page, "2".repeat(40), "3333333");
  await input.fill("main");
  await dialog.getByRole("checkbox", { name: "Overwrite existing branch" }).check();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Overwrite Branch main" });
  await expect(warning.getByRole("button", { name: "Drop Local Commits" })).toBeVisible();
  await warning.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(warning).toBeHidden();
  expect(await ipcCalls(page, "vcs_create_branch")).toEqual([]);
});

for (const [button, mode] of [
  ["Smart Checkout", "smart"],
  ["Force Checkout", "force"],
  ["Don't Checkout", null],
] as const) {
  test(`checkout during branch creation offers ${button}`, async ({ workbench: page }) => {
    const from = "2".repeat(40);
    const { dialog, input } = await openNewBranchDialog(page, from, "1111111", true);
    await input.fill("topic");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Git Checkout Problem" });
    await expect(review.getByRole("treeitem", { name: "dirty.txt" })).toBeVisible();
    await review.getByRole("button", { name: button, exact: true }).click();
    await expect(review).toBeHidden();
    await expect
      .poll(() => ipcCalls(page, "vcs_create_branch"))
      .toMatchObject(
        (mode ? ["normal", "normal", mode] : ["normal"]).map((mode) => ({
          repo: ROOT,
          name: "topic",
          start: from,
          checkout: true,
          options: { mode },
        })),
      );
  });
}

test("local changes review keeps file names and checkout choices visible", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 740 });
  const folder = "services/international-payments/regional-settlement/weekly-close/adjustments";
  const path = `${folder}/ReceiptPolicy.ts`;
  const { dialog, input } = await openNewBranchDialog(page, "2".repeat(40), "1111111", path);
  await input.fill("topic");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Git Checkout Problem" });
  const force = review.getByRole("button", { name: "Force Checkout", exact: true });
  const smart = review.getByRole("button", { name: "Smart Checkout", exact: true });
  const cancel = review.getByRole("button", { name: "Don't Checkout", exact: true });
  await expect(force).toBeVisible();
  expect((await force.boundingBox())!.x - (await review.boundingBox())!.x).toBeLessThan(24);

  await page.setViewportSize({ width: 420, height: 480 });
  const tree = review.getByRole("tree", { name: "Changed files" });
  const row = tree.getByRole("treeitem", { name: `ReceiptPolicy.ts ${folder}`, exact: true });
  await expect(row.getByTitle(path, { exact: true })).toBeVisible();
  const file = row.getByText("ReceiptPolicy.ts", { exact: true });
  await expect(file).toBeInViewport({ ratio: 1 });
  expect(await file.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(row.getByText(folder, { exact: true })).toHaveCSS("font-size", "12px");
  const restoreHint = review.getByText(/Smart Checkout .* your changes and restores them/);
  expect((await restoreHint.boundingBox())!.y).toBeLessThan((await tree.boundingBox())!.y);
  for (const button of [force, smart, cancel]) await expect(button).toBeInViewport({ ratio: 1 });
  await cancel.click();
  await expect(review).toBeHidden();
  expect(await ipcCalls(page, "vcs_create_branch")).toHaveLength(1);
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

test("the branch name and options line up, and prefix completion follows the field", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const { dialog, input } = await openNewBranchDialog(page, undefined, "1111111", false, true);
  const label = dialog.getByText("New branch name:", { exact: true });
  const checkout = dialog.getByRole("checkbox", { name: "Checkout branch" });
  const overwrite = dialog.getByRole("checkbox", { name: "Overwrite existing branch" });
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await expect(input).toHaveValue("main");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(create).toBeDisabled();
  await expect(checkout).toBeChecked();
  await expect(overwrite).not.toBeChecked();
  const labelBox = (await label.boundingBox())!;
  const fieldBox = (await input.boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThan(fieldBox.x);
  expect(Math.abs(labelBox.y + labelBox.height / 2 - (fieldBox.y + fieldBox.height / 2))).toBeLessThan(1);
  const checkoutBox = (await checkout.boundingBox())!;
  expect(Math.abs(checkoutBox.x - fieldBox.x)).toBeLessThan(1);
  expect(Math.abs(checkoutBox.y - (await overwrite.boundingBox())!.y)).toBeLessThan(1);
  await expect(input).toHaveAccessibleDescription(/already exists/i);
  await expect(label).toHaveCSS("font-size", await input.evaluate((el) => getComputedStyle(el).fontSize));
  await expect(label).toHaveCSS("font-family", await input.evaluate((el) => getComputedStyle(el).fontFamily));

  await input.fill("fea");
  const prefixes = page.getByRole("listbox", { name: "Branch name prefixes" });
  await expect(prefixes.getByRole("option", { name: "feature/" })).toBeVisible();
  expect(Math.abs((await prefixes.boundingBox())!.x - (await input.boundingBox())!.x)).toBeLessThanOrEqual(8);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("feature/");

  await page.setViewportSize({ width: 400, height: 540 });
  const stackedField = (await input.boundingBox())!;
  const stackedLabel = (await label.boundingBox())!;
  expect(stackedLabel.y + stackedLabel.height).toBeLessThanOrEqual(stackedField.y);
  expect(Math.abs(stackedLabel.x - stackedField.x)).toBeLessThan(1);
  await input.fill("feature/review-totals");
  await checkout.uncheck();
  await create.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_create_branch"))
    .toEqual([
      {
        repo: ROOT,
        name: "feature/review-totals",
        start: null,
        checkout: false,
        overwrite: false,
        expectedTip: null,
        options: null,
        shelfBatch: null,
      },
    ]);
});
