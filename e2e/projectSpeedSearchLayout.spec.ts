import { expect, test } from "./fixtures";

test("project speed search fits above the rows without taking keyboard focus", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  const project = page.getByRole("region", { name: "Project", exact: true });
  const tree = project.getByRole("tree", { name: "Project" });
  const file = tree.getByRole("treeitem", { name: "build.gradle.kts", exact: true });
  const query = "build.gradle.kts";
  await tree.focus();
  await page.keyboard.type(query);
  const search = project.getByRole("status").filter({ hasText: query });
  await expect(search).toBeVisible();
  const rows = (await tree.boundingBox())!;
  const box = (await search.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(rows.y + 1);
  expect(rows.y - box.y - box.height).toBeLessThan(4);
  expect(box.x - rows.x).toBeGreaterThanOrEqual(0);
  expect(box.x - rows.x).toBeLessThan(10);
  await expect(search).toHaveCSS("font-size", "13px");
  await expect(search).toHaveCSS("pointer-events", "none");
  await expect(tree).toBeFocused();
  await expect(file).toHaveAttribute("aria-selected", "true");
  await tree.press("Escape");
  await expect(search).toBeHidden();
  await expect(tree).toBeFocused();

  await page.evaluate(async () => {
    const module = "/src/workbench/toolwindows/store.ts";
    const { setToolWindowSize } = await import(/* @vite-ignore */ module);
    setToolWindowSize("left", 175);
  });
  await page.setViewportSize({ width: 660, height: 620 });
  const longQuery = "unmatchedSettlementReconciliationReportAcrossRegions";
  await page.keyboard.type(longQuery);
  const longSearch = project.getByRole("status").filter({ hasText: longQuery });
  await expect(longSearch).toBeInViewport({ ratio: 1 });
  const side = (await tree.boundingBox())!;
  const narrow = (await longSearch.boundingBox())!;
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(side.x + side.width + 1);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(side.y + 1);
  expect(await longSearch.getByText(longQuery).evaluate((text) => text.scrollWidth > text.clientWidth)).toBe(true);
  await expect(file).toHaveAttribute("aria-selected", "true");
  await tree.press("Escape");
  await expect(longSearch).toBeHidden();

  await page.keyboard.type("build.gradle");
  await tree.press("Enter");
  const tab = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "build.gradle.kts" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
});
