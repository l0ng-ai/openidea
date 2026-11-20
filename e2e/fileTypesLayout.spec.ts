import { expect, stubDesktop, test } from "./fixtures";

test("File Types keeps association editors usable and opens ignored rules from search", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.languages = () => [
      { id: "javascript", name: "JavaScript", extensions: ["js"] },
      { id: "python", name: "Python", extensions: ["py", "pyi", "pyw"], filenames: ["SConstruct", "SConscript"] },
    ];
  });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("File Types");
  await settings.getByRole("treeitem", { name: "File Types", exact: true }).click();
  await search.clear();

  const tabs = settings.getByRole("tablist", { name: "File Types" });
  const recognized = tabs.getByRole("tab", { name: "Recognized File Types" });
  const ignored = tabs.getByRole("tab", { name: "Ignored Files and Folders" });
  await expect(recognized).toHaveAttribute("aria-selected", "true");
  const divider = settings.getByRole("separator", { name: "Resize file type panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");

  await page.setViewportSize({ width: 520, height: 660 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const types = settings.getByRole("listbox", { name: "Recognized file types", exact: true });
  await types.getByRole("option", { name: "Python", exact: true }).click();
  const patterns = settings.getByRole("listbox", { name: "File name patterns of Python" });
  const hashbangLabel = settings.getByText("Hashbang patterns", { exact: true });
  await expect
    .poll(async () => {
      const nameList = await patterns.boundingBox();
      const hashbangHeading = await hashbangLabel.boundingBox();
      return nameList && hashbangHeading ? hashbangHeading.y - (nameList.y + nameList.height) : -1;
    })
    .toBeGreaterThan(0);
  await expect
    .poll(() => settings.locator("[class*='_patterns_']").evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  const toolbar = settings.locator(`[role="toolbar"][aria-controls="${await patterns.getAttribute("id")}"]`);
  await toolbar.getByRole("button", { name: "Add" }).click();
  const pattern = patterns.getByRole("textbox", { name: "Pattern" });
  await pattern.fill("*.layout-demo");
  await pattern.press("Enter");
  await expect(patterns.getByRole("option", { name: "*.layout-demo", exact: true })).toBeVisible();
  await expect
    .poll(() => settings.locator("[class*='pageBody']").evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);

  await search.fill("Exclude patterns");
  await expect(ignored).toHaveAttribute("aria-selected", "true");
  await expect(settings.getByRole("listbox", { name: "Exclude patterns" })).toBeVisible();
  await expect(patterns).toBeHidden();
  await ignored.click();
  await search.clear();
  await ignored.press("ArrowLeft");
  await expect(recognized).toHaveAttribute("aria-selected", "true");
  await expect(patterns.getByRole("option", { name: "*.layout-demo", exact: true })).toBeVisible();
});
