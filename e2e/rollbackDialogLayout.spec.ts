import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Rollback fits a short window and scopes its options to checked files", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 410, height: 330 });
  await stubDesktop(page);
  const root = "/dev/settlement-engine";
  const added = `${root}/ledger/additional-settlement-schedule.txt`;
  const deleted = `${root}/ledger/retired-settlement-routing.txt`;
  const modified = Array.from({ length: 16 }, (_, i) => `${root}/ledger/merchant-settlement-batch-${i + 1}.txt`);

  await page.evaluate(
    async ({ root, added, deleted, modified }) => {
      const status = [
        { path: added, staged: "added", unstaged: null },
        { path: deleted, staged: "deleted", unstaged: null },
        ...modified.map((path) => ({ path, staged: null, unstaged: "modified" })),
      ].map((file) => ({ ...file, relPath: file.path.slice(root.length + 1), renamedFrom: null }));
      const branch = { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null };
      const h = window.__ipc.handlers;
      h.vcs_branch_info = () => branch;
      h.vcs_roots = () => [{ root, ...branch }];
      h.vcs_status = () => status;
      h.vcs_unstage = () => null;
      h.vcs_discard = () => null;

      const storeModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ storeModule);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branch, status });
      const contextModule = "/src/platform/context.ts";
      const { setContext } = await import(/* @vite-ignore */ contextModule);
      setContext("vcsAvailable", true);
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("vcs.rollback", [root]);
    },
    { root, added, deleted, modified },
  );

  const dialog = page.getByRole("dialog", { name: "Rollback Changes", exact: true });
  const tree = dialog.getByRole("tree", { name: "Files to roll back" });
  const body = dialog.locator("[data-dialog-body]");
  await expect(tree).toBeVisible();
  expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(await tree.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(tree).toBeFocused();
  await expect(tree.getByTitle("ledger/additional-settlement-schedule.txt", { exact: true })).toBeVisible();

  const status = dialog.getByRole("status");
  const deleteCopies = dialog.getByRole("checkbox", { name: "Delete local copies of added files" });
  const rollback = dialog.getByRole("button", { name: "Rollback", exact: true });
  await expect(status).toHaveText("1 added16 modified1 deleted");
  await expect(deleteCopies).toBeEnabled();
  await expect(deleteCopies).not.toBeChecked();
  await deleteCopies.check();
  await tree.getByRole("checkbox", { name: "Include additional-settlement-schedule.txt" }).uncheck();
  await expect(deleteCopies).toBeDisabled();
  await expect(status).toHaveText("16 modified1 deleted");

  const rootCheckbox = tree.getByRole("checkbox", { name: "Include settlement-engine", exact: true });
  await expect(rootCheckbox).toHaveAttribute("aria-checked", "mixed");
  await rootCheckbox.click();
  await rootCheckbox.uncheck();
  await expect(rollback).toBeDisabled();
  await expect(status).toHaveText("No files selected");

  await tree.getByRole("checkbox", { name: "Include merchant-settlement-batch-1.txt", exact: true }).check();
  await expect(status).toHaveText("1 modified");
  await expect(deleteCopies).toBeDisabled();
  await rollback.click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => ipcCalls(page, "vcs_discard")).toEqual([{ paths: [modified[0]] }]);
  expect(await ipcCalls(page, "vcs_unstage")).toEqual([]);
});
