import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function selectPage(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage(id);
  }, id);
}

test("settings forms share control columns and keep font metrics on one row", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await selectPage(page, "appearance");
  const controls = ["Theme", "Editor color scheme"].map((name) => dialog.getByRole("button", { name, exact: true }));
  for (const control of controls) await expect(control).toBeVisible();
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  for (const box of boxes) expect(box!.x).toBeCloseTo(boxes[0]!.x, 0);

  await selectPage(page, "editor.font");
  const font = dialog.getByRole("combobox", { name: "Font", exact: true });
  const size = dialog.getByRole("textbox", { name: "Size", exact: true });
  const line = dialog.getByRole("textbox", { name: "Line height", exact: true });
  await expect(line).toBeVisible();
  const [fontBox, sizeBox, lineBox] = await Promise.all([font.boundingBox(), size.boundingBox(), line.boundingBox()]);
  expect(fontBox!.x).toBeCloseTo(sizeBox!.x, 0);
  expect(lineBox!.y).toBeCloseTo(sizeBox!.y, 0);
  expect(lineBox!.x).toBeGreaterThan(sizeBox!.x + sizeBox!.width);
  const weights = await Promise.all(
    ["Main font weight", "Bold font weight"].map((name) =>
      dialog.getByRole("button", { name, exact: true }).boundingBox(),
    ),
  );
  const fallback = await dialog.getByRole("combobox", { name: "Fallback font", exact: true }).boundingBox();
  for (const box of weights) expect(box!.x).toBeCloseTo(fallback!.x, 0);
  for (const name of ["Main font weight", "Bold font weight", "Fallback font"]) {
    const singleLine = await dialog.getByText(name, { exact: true }).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(el).lineHeight) + 1;
    });
    expect(singleLine, name).toBe(true);
  }
});

for (const locale of ["en", "zh"]) {
  test(`${locale} forms fit narrow settings panes without horizontal scrolling`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(async (locale) => {
      const path = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ path)).setLocale(locale);
    }, locale);
    for (const id of ["appearance", "editor.font", "general", "general.httpProxy"]) {
      await selectPage(page, id);
      const body = page.locator("[class*='pageBody']");
      for (const width of [1000, 784, 640, 520]) {
        await page.setViewportSize({ width, height: 760 });
        await expect
          .poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${id} at ${width}px` })
          .toBeLessThanOrEqual(1);
      }
    }
  });
}

test("settings sidebar resizes with mouse and keyboard and remembers its width", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const handle = dialog.getByRole("separator", { name: "Settings pages", exact: true });
  await expect(handle).toBeVisible();
  const sidebar = dialog.locator("#navigation");
  const initial = (await sidebar.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(initial + 40);
  const resized = (await sidebar.boundingBox())!.width;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await expect(handle).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(resized, 0);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(resized);
});
