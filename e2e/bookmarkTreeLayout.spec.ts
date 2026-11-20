import { expect, test } from "./fixtures";

test("line bookmarks keep their code or description readable in the dock", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 880, height: 640 });
  const name = "QuarterlySettlementReconciliationCoordinator.ts";
  const path = `/dev/acme-api/${name}`;
  const code = "reconcileCheckoutOrders();";
  const description = "Review settlement totals";
  await page.evaluate(
    async ({ path, code }) => {
      const backendModule = "/src/editor/core/backend.ts";
      const { docBackend } = await import(/* @vite-ignore */ backendModule);
      docBackend().files.set(path, [...Array(27).fill("// Settlement rules"), code, "verifyTotals();", ""].join("\n"));
      const services = "/src/workbench/contributions.ts";
      const { editorService } = await import(/* @vite-ignore */ services);
      await editorService().openFile(path);
    },
    { path, code },
  );
  await expect(page.locator(".cm-content")).toContainText(code);
  await page.evaluate(
    async ({ path, description }) => {
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("navigate.toggleBookmark", { path, line: 27 });
      await executeAction("navigate.toggleBookmark", { path, line: 29 });
      const bookmarkModule = "/src/features/search/bookmarks/store.ts";
      const { assignMnemonic, updateBookmarks } = await import(/* @vite-ignore */ bookmarkModule);
      updateBookmarks((items: unknown[]) => assignMnemonic(items, path, 28, "verifyTotals();", "4", description));
      await executeAction("toolwindow.bookmarks");
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const { setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
      setToolWindowSize("left", 240);
    },
    { path, description },
  );

  const tree = page.getByRole("tree", { name: "Bookmarks" });
  await expect(tree.getByText(name, { exact: true })).toBeVisible();
  const snippet = tree.getByText(code, { exact: true });
  await expect.poll(() => snippet.evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(105);
  await expect(tree.getByText("28:", { exact: true })).toBeVisible();
  await expect(tree.getByText("29:", { exact: true })).toBeVisible();
  await expect(tree.getByText(description, { exact: true })).toBeVisible();
  await expect(tree.getByText("(empty line)", { exact: true })).toBeVisible();
  expect(await tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);

  const row = tree.getByRole("treeitem").filter({ hasText: code });
  await row.click();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/workbench/contributions.ts";
        const { editorService } = await import(/* @vite-ignore */ module);
        const cursor = editorService().activeCursor();
        return { path: cursor?.path, line: cursor?.line };
      }),
    )
    .toEqual({ path, line: 27 });
});
