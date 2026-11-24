import { expect, test } from "./fixtures";

const root = "/dev/acme-api";
const stem = "InternationalSettlementRegionalReconciliationAndAuditWarehouseAllocationConfiguration";
const original = stem + ".txt";
const renamed = "WarehouseAllocation.txt";

test("file rename groups the name and reflows the options without losing validation", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(
    async ({ root, original }) => {
      const fsModule = "/src/features/project-tree/fs.ts";
      const storeModule = "/src/features/project-tree/store.ts";
      const { projectFs } = await import(/* @vite-ignore */ fsModule);
      const { loadDir } = await import(/* @vite-ignore */ storeModule);
      await projectFs(root).createFile(root + "/" + original);
      await loadDir(root, true);
    },
    { root, original },
  );
  const source = page.getByRole("treeitem", { name: original, exact: true });
  await source.click();
  await page.keyboard.press("Shift+F6");

  const dialog = page.getByRole("dialog", { name: "Rename", exact: true });
  const prompt = dialog.getByText("Rename file '" + original + "' and its usages to:", { exact: true });
  const field = dialog.getByRole("textbox", { name: "New name" });
  const references = dialog.getByRole("checkbox", { name: "Search for references" });
  const comments = dialog.getByRole("checkbox", { name: "Search in comments and strings" });
  const submit = dialog.getByRole("button", { name: "Refactor", exact: true });
  const referencesRow = references.locator("xpath=ancestor::label");
  const commentsRow = comments.locator("xpath=ancestor::label");

  await expect(field).toBeFocused();
  const selected = await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!));
  expect(selected).toBe(stem);

  await expect
    .poll(async () => {
      const a = (await prompt.boundingBox())!;
      const b = (await field.boundingBox())!;
      return b.y - a.y - a.height;
    })
    .toBeCloseTo(4, 0);
  await expect
    .poll(async () => {
      const a = (await referencesRow.boundingBox())!;
      const b = (await commentsRow.boundingBox())!;
      return Math.abs(a.y - b.y) < 1 && b.x >= a.x + a.width;
    })
    .toBe(true);

  await field.fill("README.md");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.setViewportSize({ width: 400, height: 520 });
  await expect
    .poll(async () => {
      const a = (await referencesRow.boundingBox())!;
      const b = (await commentsRow.boundingBox())!;
      return b.y >= a.y + a.height;
    })
    .toBe(true);
  await expect(field).toHaveValue("README.md");
  await expect(prompt).toBeInViewport({ ratio: 1 });
  await expect(submit).toBeInViewport({ ratio: 1 });
  expect(
    await dialog.locator("[data-dialog-body]").evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);

  await field.fill(renamed);
  await expect(dialog.getByRole("alert")).toBeHidden();
  await references.uncheck();
  await comments.uncheck();
  await submit.click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.getByRole("treeitem", { name: renamed, exact: true })).toBeVisible();
  await expect(source).toHaveCount(0);
});
