import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

async function bookmarkAction(page: Page, id: "navigate.toggleBookmark" | "navigate.showBookmarks") {
  await page.evaluate(async (id) => {
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction(id);
  }, id);
}

test("Bookmarks remembers its size and keeps the list and preview usable in a narrow window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  const resizeErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("ResizeObserver loop")) resizeErrors.push(error.message);
  });
  const editor = await openFromTree(page, "build.gradle.kts");
  const first = "val order: Order = service.create(req)";
  const second = "return order.toDto()";
  for (const line of [first, second]) {
    await editor.locator(".cm-line", { hasText: line }).click();
    await bookmarkAction(page, "navigate.toggleBookmark");
  }

  await bookmarkAction(page, "navigate.showBookmarks");
  const dialog = page.getByRole("dialog", { name: "Bookmarks", exact: true });
  const list = dialog.getByRole("listbox", { name: "Bookmarks" });
  const preview = dialog.getByRole("region", { name: "Preview" });
  const divider = dialog.getByRole("separator", { name: "Resize bookmark panes", exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(list).toBeFocused();
  await expect(list.getByRole("option", { selected: true })).toContainText(first);
  await expect(preview.locator(".cm-activeLine")).toContainText(first);
  const lineNumbers = list.getByRole("option").locator(":scope > span > span:last-child");
  const [firstNumber, secondNumber] = await Promise.all([
    lineNumbers.nth(0).boundingBox(),
    lineNumbers.nth(1).boundingBox(),
  ]);
  expect(firstNumber!.x + firstNumber!.width).toBeCloseTo(secondNumber!.x + secondNumber!.width, 0);
  const initial = (await dialog.boundingBox())!;
  expect(initial.x + initial.width / 2).toBeCloseTo(600, 0);
  expect(Math.abs(initial.y + initial.height / 2 - 410)).toBeLessThan(16);

  const listWidth = (await list.boundingBox())!.width;
  await divider.press("ArrowRight");
  await expect.poll(async () => (await list.boundingBox())!.width).toBeGreaterThan(listWidth + 4);

  const corner = (await dialog.getByRole("separator", { name: "Resize", exact: true }).boundingBox())!;
  const x = corner.x + corner.width / 2;
  const y = corner.y + corner.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 48, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThan(initial.width + 50);
  const resized = (await dialog.boundingBox())!;
  expect(resized.height).toBeGreaterThan(initial.height + 30);
  const resizedList = (await list.boundingBox())!.width;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await bookmarkAction(page, "navigate.showBookmarks");
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeCloseTo(resized.width, 0);
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(resized.height, 0);
  await expect.poll(async () => Math.abs((await list.boundingBox())!.width - resizedList)).toBeLessThan(2);

  await page.setViewportSize({ width: 470, height: 430 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const narrowList = (await list.boundingBox())!;
  const narrowPreview = (await preview.boundingBox())!;
  expect(narrowPreview.y).toBeGreaterThanOrEqual(narrowList.y + narrowList.height - 1);
  expect(narrowPreview.width).toBeCloseTo(narrowList.width, 0);
  expect(narrowPreview.height).toBeGreaterThan(100);
  await expect(dialog).toBeInViewport({ ratio: 1 });

  await list.press("ArrowDown");
  await expect(list.getByRole("option", { selected: true })).toContainText(second);
  await expect(preview.locator(".cm-activeLine")).toContainText(second);
  await list.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toContainText(second);
  expect(resizeErrors).toEqual([]);
});
