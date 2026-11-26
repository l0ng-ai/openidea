import { expect, openFromTree, test } from "./fixtures";

test("the line separator menu has a heading and keeps the current choice visible", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  const status = page.locator('[data-status-item="editor.lineEnding"]').getByRole("button");
  const menu = page.getByRole("menu", { name: /^Line Separator$/i });
  const windows = "Windows (\\r\\n)";
  const unix = "Unix and macOS (\\n)";
  const classic = "Classic Mac OS (\\r)";
  await expect(status).toHaveText("LF");
  await status.click();
  const heading = menu.locator("..").getByText("Line Separator", { exact: true });
  expect(await heading.count()).toBe(1);
  await expect(heading).toHaveCSS("font-size", "13px");
  await expect(menu.locator('[role^="menuitem"]')).toHaveText([windows, unix, classic]);

  await page.setViewportSize({ width: 540, height: 540 });
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("menuitemcheckbox", { name: unix, checked: true })).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("menuitem", { name: windows })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("CRLF");

  await status.click();
  await expect(menu.getByRole("menuitemcheckbox", { name: windows, checked: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("LF");

  await page.evaluate(async () => {
    const path = "/src/platform/i18n.ts";
    await (await import(/* @vite-ignore */ path)).setLocale("zh");
  });
  await status.click();
  const translated = page.getByRole("menu", { name: "行分隔符", exact: true });
  await expect(translated.getByRole("menuitem", { name: "Windows 换行 (\\r\\n)", exact: true })).toBeVisible();
});

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
