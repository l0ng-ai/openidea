import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

async function choosePreviewLayout(page: Page, layout: "Side by side" | "Stacked") {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Markdown");
  await settings.getByRole("treeitem", { name: "Markdown", exact: true, level: 2 }).click();
  const select = settings.getByRole("button", { name: "Preview layout", exact: true });
  await expect(select).toBeVisible();
  await select.click();
  await page.getByRole("option", { name: layout, exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
}

async function ratio(editor: Locator, preview: Locator, axis: "height" | "width") {
  const [source, rendered] = await Promise.all([editor.boundingBox(), preview.boundingBox()]);
  return source![axis] / (source![axis] + rendered![axis]);
}

test("Markdown settings can stack the preview and remember each direction's split", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await page.evaluate(() =>
    localStorage.setItem("openidea.markdown.split", JSON.stringify({ editor: 65, preview: 35 })),
  );
  const editor = await openFromTree(page, "README.md");
  const preview = page.getByRole("document", { name: "Markdown preview" });
  const divider = page.getByRole("separator", { name: "Resize Markdown preview" });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => ratio(editor, preview, "width")).toBeCloseTo(0.65, 2);

  await choosePreviewLayout(page, "Stacked");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const source = (await editor.boundingBox())!;
  const rendered = (await preview.boundingBox())!;
  expect(rendered.y).toBeGreaterThanOrEqual(source.y + source.height);
  expect(rendered.x).toBeCloseTo(source.x, 0);
  expect(rendered.width).toBeCloseTo(source.width, 0);
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(0.5, 2);

  await divider.press("ArrowUp");
  await expect.poll(() => ratio(editor, preview, "height")).toBeLessThan(0.49);
  const stackedRatio = await ratio(editor, preview, "height");

  await choosePreviewLayout(page, "Side by side");
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => ratio(editor, preview, "width")).toBeCloseTo(0.65, 2);
  await choosePreviewLayout(page, "Stacked");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(stackedRatio, 2);

  await page.getByRole("button", { name: "Preview Only" }).click();
  await expect(preview).toBeVisible();
  await expect(divider).toBeHidden();
  await page.getByRole("button", { name: "Editor and Preview" }).click();
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(stackedRatio, 2);
});
