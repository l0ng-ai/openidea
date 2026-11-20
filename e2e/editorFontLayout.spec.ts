import { expect, test } from "./fixtures";

test("Editor Font keeps the preview in view while editing and resizing the controls", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Show only monospaced fonts");
  await settings.getByRole("treeitem", { name: "Font", exact: true, level: 2 }).click();
  await search.clear();

  const divider = settings.getByRole("separator", { name: "Resize font preview" });
  const options = settings.getByRole("region", { name: "Font options", exact: true });
  const preview = settings.getByRole("textbox", { name: "Font preview", exact: true });
  const font = options.getByRole("combobox", { name: "Font", exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  expect((await font.boundingBox())!.x).toBeLessThan((await preview.boundingBox())!.x);
  await expect.poll(() => preview.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await preview.fill("function main() { return 42; }");
  await options.getByRole("textbox", { name: "Size", exact: true }).fill("18");
  await options.getByRole("textbox", { name: "Line height", exact: true }).fill("25");
  await expect(preview).toHaveCSS("font-size", "18px");
  await expect(preview).toHaveCSS("line-height", "25px");

  await page.setViewportSize({ width: 520, height: 620 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  expect((await font.boundingBox())!.y).toBeLessThan((await preview.boundingBox())!.y);
  await expect(preview).toHaveValue("function main() { return 42; }");
  const y = (await divider.boundingBox())!.y;
  await divider.press("ArrowDown");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeGreaterThan(y + 1);

  await search.fill("Fallback font");
  const fallback = options.getByRole("combobox", { name: "Fallback font", exact: true });
  await fallback.scrollIntoViewIfNeeded();
  await expect(fallback).toBeInViewport();
  await fallback.fill("Consolas");
  await expect(preview).toHaveCSS("font-family", /Consolas/);
  await expect(preview).toBeInViewport();
  await expect.poll(() => options.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
