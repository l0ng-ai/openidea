import { expect, openFromTree, test } from "./fixtures";

test("status bar uses its row height and widget insets in both densities", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const bar = page.locator('footer[aria-label="Status bar"]');
  const lineEnding = bar.locator('[data-status-item="editor.lineEnding"]');
  const encoding = bar.locator('[data-status-item="editor.encoding"]');
  await expect(lineEnding.getByRole("button")).toBeVisible();
  await expect(encoding.getByRole("button")).toBeVisible();
  await expect(bar).toHaveCSS("height", "30px");
  await expect(encoding.getByRole("button")).toHaveCSS("font-size", "13px");

  const widgetGap = async () => {
    const left = await lineEnding.boundingBox();
    const right = await encoding.boundingBox();
    return right!.x - left!.x - left!.width;
  };
  await expect.poll(widgetGap).toBeCloseTo(0, 1);

  await page.locator("html").evaluate((root) => root.setAttribute("data-compact", ""));
  await expect(bar).toHaveCSS("height", "24px");
  await expect(encoding.getByRole("button")).toHaveCSS("font-size", "12px");
  await expect.poll(widgetGap).toBeCloseTo(0, 1);

  await editor.locator(".cm-content").press("Meta+a");
  await page.setViewportSize({ width: 400, height: 620 });
  const more = bar.getByRole("button", { name: "Show more" });
  await expect(more).toBeVisible();
  await more.press("Enter");
  const popup = page.getByRole("dialog", { name: "Show more" });
  await expect(popup).toBeInViewport({ ratio: 1 });
  await expect(popup.getByRole("button", { name: /chars/ })).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 620 });
  await expect(popup).toBeHidden();
  await expect(more).toBeHidden();
});
