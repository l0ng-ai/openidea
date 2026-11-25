import { expect, openFromTree, test } from "./fixtures";

test("Copy Path/Reference keeps its preview and shortcut visible and can be resized", async ({
  workbench: page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").press("Meta+Shift+C");

  const popup = page.getByRole("dialog", { name: "Copy Path/Reference…" });
  const absolute = popup.getByRole("option", { name: /^Absolute Path(?! with)/ });
  const preview = absolute.locator('[title$="/build.gradle.kts"]');
  const shortcut = absolute.getByText(/⌘/);
  await expect(preview).toBeVisible();
  await expect(popup).toHaveCSS("width", "500px");
  await expect(shortcut).toBeVisible();
  const previewBox = (await preview.boundingBox())!;
  const shortcutBox = (await shortcut.boundingBox())!;
  expect(shortcutBox.x + shortcutBox.width).toBeLessThan(previewBox.x);
  await expect(preview).toHaveCSS("font-size", "13px");

  const handle = popup.getByRole("separator", { name: "Resize" });
  const height = (await popup.boundingBox())!.height;
  const corner = (await handle.boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + 125, corner.y + 25, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await popup.boundingBox())!.width).toBeGreaterThan(595);
  await expect.poll(async () => (await popup.boundingBox())!.height).toBeGreaterThan(height + 10);

  await page.setViewportSize({ width: 440, height: 660 });
  await expect(popup).toBeInViewport({ ratio: 1 });
  await expect(shortcut).toBeInViewport({ ratio: 1 });
  await expect(preview).toBeInViewport({ ratio: 1 });
  const path = await preview.getAttribute("title");
  await page.keyboard.type("absolute");
  await expect(absolute).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path);
});
