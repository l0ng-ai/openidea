import { doubleShift, expect, stubDesktop, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function searchFiles(page: Page) {
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.find_files = () =>
      Array.from({ length: 24 }, (_, i) => ({
        path: `/dev/acme-api/src/main/kotlin/com/acme/orders/service/OrderService${i}.kt`,
        relPath: `src/main/kotlin/com/acme/orders/service/OrderService${i}.kt`,
        score: 100 - i,
        indices: [],
      }));
  });
  await doubleShift(page);
  const dialog = page.locator('[role="dialog"]:has(#se-query)');
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Search query" }).fill("OrderService");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  return dialog;
}

for (const count of [1, 2, 24]) {
  test(`without the preview the results list shows its rows (${count} results)`, async ({ workbench: page }) => {
    await stubDesktop(page);
    await page.evaluate((count) => {
      window.__ipc.handlers.find_files = () =>
        Array.from({ length: count }, (_, i) => ({
          path: `/dev/acme-api/src/main${i}.js`,
          relPath: `src/main${i}.js`,
          score: 100 - i,
          indices: [],
        }));
    }, count);
    await doubleShift(page);
    const dialog = page.locator('[role="dialog"]:has(#se-query)');
    await dialog.getByRole("tab", { name: "Files", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Search query" }).fill("main");
    await expect(dialog.getByRole("separator", { name: "Preview", exact: true })).toBeHidden();
    const list = dialog.getByRole("listbox", { name: "Results" });
    await expect
      .poll(async () => (await list.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(Math.min(count, 5) * 24);
  });
}

test("preview splitter resizes with mouse and keyboard, keeps query focus and remembers its ratio", async ({
  workbench: page,
}) => {
  const dialog = await searchFiles(page);
  const query = dialog.getByRole("combobox", { name: "Search query" });
  const list = dialog.getByRole("listbox", { name: "Results" });
  const handle = dialog.getByRole("separator", { name: "Preview", exact: true });
  await expect(handle).toBeVisible();
  const initial = (await list.boundingBox())!.height;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 70, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(initial + 50);
  await expect(query).toBeFocused();
  const dragged = (await list.boundingBox())!.height;
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(handle).toBeHidden();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(async () => Math.abs((await list.boundingBox())!.height - dragged)).toBeLessThan(2);
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(dragged + 10);
  await expect(handle).toBeFocused();
  const resized = (await list.boundingBox())!.height;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+o");
  await expect(query).toHaveValue("OrderService");
  await expect.poll(async () => Math.abs((await list.boundingBox())!.height - resized)).toBeLessThan(2);
  await expect(query).toBeFocused();
});

test("keyboard selection stays in view, announces the active result and updates the preview", async ({
  workbench: page,
}) => {
  const dialog = await searchFiles(page);
  const query = dialog.getByRole("combobox", { name: "Search query" });
  const list = dialog.getByRole("listbox", { name: "Results" });
  const preview = dialog.getByRole("region", { name: "Preview", exact: true });
  await expect(preview.locator(".cm-content")).toHaveAttribute("aria-label", /OrderService0\.kt$/);
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowDown");
  await expect(query).toBeFocused();
  const lead = list.locator('[data-lead="true"]');
  await expect(lead).toContainText("OrderService18.kt");
  await expect(preview.locator(".cm-content")).toHaveAttribute("aria-label", /OrderService18\.kt$/);
  await expect(query).toHaveAttribute("aria-activedescendant", (await lead.getAttribute("id"))!);
  const bounds = (await list.boundingBox())!;
  const row = (await lead.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const handle = (await dialog.getByRole("separator", { name: "Preview", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 45, { steps: 8 });
  await page.mouse.up();
  await expect(query).toBeFocused();
  await expect
    .poll(async () => {
      const bounds = (await list.boundingBox())!;
      const row = (await lead.boundingBox())!;
      return row.y >= bounds.y - 1 && row.y + row.height <= bounds.y + bounds.height + 1;
    })
    .toBe(true);
});

for (const locale of ["en", "zh"]) {
  test(`${locale} tabs and query fit narrow windows at normal and 125% scale`, async ({ workbench: page }) => {
    const dialog = await searchFiles(page);
    await page.evaluate(async (locale) => {
      const path = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ path)).setLocale(locale);
    }, locale);
    for (const size of [
      { width: 1000, height: 760 },
      { width: 720, height: 608 },
      { width: 520, height: 608 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const header = dialog.locator('[data-dialog-drag=""]').first();
      await expect.poll(() => header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const input = dialog.locator("#se-query");
      expect((await input.boundingBox())!.width).toBeGreaterThan(160);
      for (let i = 0; i < 6; i++) {
        await input.press("Tab");
        await expect(input).toBeFocused();
        const selected = dialog.getByRole("tab", { selected: true });
        await expect(selected).toBeInViewport({ ratio: 1 });
      }
      await expect(dialog.getByRole("region").first()).toBeVisible();
      const footer = dialog.locator("footer");
      await expect(footer).toBeInViewport({ ratio: 1 });
    }
  });
}

test("mixed file and action rows align icons and names and keep shortcuts readable", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.find_files = () => [
      {
        path: "/dev/acme-api/src/main/kotlin/com/acme/navigation/FindAction.kt",
        relPath: "src/main/kotlin/com/acme/navigation/FindAction.kt",
        score: 100,
        indices: [],
      },
    ];
  });
  await doubleShift(page);
  const dialog = page.locator('[role="dialog"]:has(#se-query)');
  await dialog.getByRole("combobox").fill("Find Action");
  const file = dialog.getByRole("option", { name: /FindAction.kt/ });
  const action = dialog.locator('[class*="actionRow"]').filter({ hasText: "Find Action" }).first();
  await expect(file).toBeVisible();
  await expect(action).toBeVisible();
  const fileName = (await file.locator('[class*="main"] > [class*="name"]').boundingBox())!;
  const actionName = (await action.locator('[class*="main"] > [class*="name"]').boundingBox())!;
  expect(Math.abs(fileName.x - actionName.x)).toBeLessThan(1);
  const shortcut = action.locator('[class*="shortcut"]');
  await expect(shortcut).toBeVisible();
  const keys = (await shortcut.boundingBox())!;
  expect(keys.x).toBeGreaterThanOrEqual(actionName.x + actionName.width);
  expect(await shortcut.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
