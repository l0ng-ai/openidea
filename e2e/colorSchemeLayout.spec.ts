import { expect, test } from "./fixtures";

test("Color Scheme keeps the preview visible while editing an attribute in narrow Settings", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Language Defaults");
  await settings.getByRole("treeitem", { name: "Language Defaults", exact: true }).click();
  await search.clear();

  const divider = settings.getByRole("separator", { name: "Resize color scheme preview", exact: true });
  const tree = settings.getByRole("tree", { name: "Color scheme attributes", exact: true });
  const options = settings.getByRole("region", { name: "Color scheme options", exact: true });
  const preview = settings.getByLabel("Color scheme preview", { exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  expect((await tree.boundingBox())!.x).toBeLessThan((await options.boundingBox())!.x);

  await page.setViewportSize({ width: 520, height: 660 });
  await expect.poll(async () => (await tree.boundingBox())!.y).toBeLessThan((await options.boundingBox())!.y);
  const previewTop = (await preview.boundingBox())!.y;
  const token = preview.getByText("class", { exact: true }).first();
  await token.click();
  await expect(tree.getByRole("treeitem", { name: "Keyword", exact: true, selected: true })).toBeVisible();
  await options.getByRole("textbox", { name: "Foreground hex", exact: true }).fill("#118899");
  await expect(token).toHaveCSS("color", "rgb(17, 136, 153)");
  await expect(preview).toBeInViewport();
  expect((await preview.boundingBox())!.y).toBeCloseTo(previewTop, 0);
  await expect
    .poll(() => settings.locator("[class*='pageBody']").evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  await options.getByRole("checkbox", { name: "Semantic highlighting" }).scrollIntoViewIfNeeded();
  expect((await preview.boundingBox())!.y).toBeCloseTo(previewTop, 0);

  const before = (await divider.boundingBox())!.y;
  await divider.press("ArrowUp");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeLessThan(before - 1);
});
