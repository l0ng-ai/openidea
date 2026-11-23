import { expect, test } from "./fixtures";

test("Settings aligns search results with their parent pages and honors smaller tree indents", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  const tree = dialog.getByRole("tree", { name: "Settings pages" });
  await search.fill("Language Defaults");

  const editor = tree.getByRole("treeitem", { name: "Editor", exact: true });
  const scheme = tree.getByRole("treeitem", { name: "Color Scheme", exact: true });
  const defaults = tree.getByRole("treeitem", { name: "Language Defaults", exact: true });
  await expect(defaults).toHaveAttribute("aria-selected", "true");
  await expect(defaults.locator("mark")).toHaveText(["Language", "Defaults"]);

  const insets = () =>
    Promise.all(
      [editor, scheme, defaults].map((row) =>
        row.locator(":scope > span:last-child").evaluate((label) => {
          const left = label.closest('[role="tree"]')!.getBoundingClientRect().left;
          return Math.round(label.getBoundingClientRect().left - left);
        }),
      ),
    );
  await expect.poll(insets).toEqual([28, 44, 60]);
  await page.setViewportSize({ width: 580, height: 720 });
  await expect.poll(insets).toEqual([28, 44, 60]);
  await page.evaluate(() => document.documentElement.style.setProperty("--tree-indent", "12px"));
  await expect.poll(insets).toEqual([28, 40, 52]);

  await search.press("ArrowUp");
  await expect(scheme).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  await expect(editor).toHaveAttribute("aria-selected", "true");
  await expect(search).toBeFocused();
});
