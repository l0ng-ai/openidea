import { expect, test } from "./fixtures";

test("Keymap fits a narrow Settings pane and keeps shortcut editing reachable", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 760 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();

  const search = settings.getByRole("textbox", { name: "Search actions" });
  const expand = settings.getByRole("button", { name: "Expand All", exact: true });
  await expect(search).toBeVisible();
  const wideSearch = (await search.boundingBox())!;
  const wideExpand = (await expand.boundingBox())!;
  expect(wideExpand.x).toBeLessThan(wideSearch.x);
  expect(Math.abs(wideExpand.y - wideSearch.y)).toBeLessThan(8);

  await page.setViewportSize({ width: 520, height: 760 });
  const narrowSearch = (await search.boundingBox())!;
  const narrowExpand = (await expand.boundingBox())!;
  expect(narrowSearch.y).toBeGreaterThan(narrowExpand.y + narrowExpand.height);

  const body = settings.locator("[class*='pageBody']");
  const fitPane = () =>
    expect.poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await fitPane();

  await search.fill("Reformat Code");
  const tree = settings.getByRole("tree", { name: "Actions", exact: true });
  const action = tree
    .getByRole("treeitem")
    .filter({ hasText: /Reformat Code/ })
    .first();
  await action.click();
  await settings.getByRole("button", { name: "Add Keyboard Shortcut", exact: true }).click();
  const recorder = page.getByRole("dialog", { name: /Keyboard Shortcut: Reformat Code/ });
  await recorder.getByRole("textbox", { name: "First stroke" }).press("Control+Alt+Shift+F8");
  await expect(recorder.getByText("No conflicts")).toBeVisible();
  await recorder.getByRole("button", { name: "OK", exact: true }).click();
  await expect(action.locator("kbd").filter({ hasText: "F8" })).toHaveCount(1);

  const title = action.getByText(/Reformat Code/).first();
  await expect.poll(() => title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await tree.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  expect(await tree.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await fitPane();

  await settings.getByRole("button", { name: "Find Actions by Shortcut" }).click();
  await settings.getByRole("textbox", { name: "Find actions by shortcut" }).press("Control+Alt+Shift+F8");
  await expect(action).toBeVisible();
  await fitPane();

  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
});
