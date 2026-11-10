import { test, expect, type Page } from "@playwright/test";

async function titleBarHeight(page: Page) {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--h-titlebar")));
}

// Reduced motion skips the opening animation, which scales the dialog while it runs.
test.use({ viewport: { width: 1200, height: 640 }, reducedMotion: "reduce" });

test("a dialog taller than the window stays below the macOS window buttons", async ({ page }) => {
  await page.goto("/e2e/dialogTitleBar.html");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(await titleBarHeight(page));
});

test("dragging a dialog up stops below the macOS window buttons", async ({ page }) => {
  await page.goto("/e2e/dialogTitleBar.html");
  const title = page.getByRole("dialog").locator("[data-dialog-titlebar] span").last();
  const start = (await title.boundingBox())!;
  await page.mouse.move(start.x + 40, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, 0, { steps: 8 });
  await page.mouse.up();
  const box = (await page.getByRole("dialog").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(await titleBarHeight(page));
});
