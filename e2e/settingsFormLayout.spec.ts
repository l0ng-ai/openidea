import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function selectPage(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage(id);
  }, id);
}

test("Git settings expose fetch tag modes and the check-only mode", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await selectPage(page, "vcs.git");
  const mode = dialog.getByRole("button", { name: "Fetch tags", exact: true });
  await expect(mode).toHaveText("Auto");
  await mode.click();
  const choices = page.getByRole("listbox");
  for (const label of ["Auto", "Sync", "Always", "Never"]) {
    await expect(choices.getByRole("option", { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  const sync = choices.getByRole("option", { name: /^Sync/ });
  await expect(sync).toContainText("Delete local tags missing on remote");
  await sync.click();
  await expect(mode).toHaveText("Sync");
  const incoming = dialog.getByRole("button", { name: "Explicitly check for incoming commits on remotes" });
  await incoming.click();
  await choices.getByRole("option", { name: "Check without fetching", exact: true }).click();
  await expect(incoming).toHaveText("Check without fetching");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
});

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
    for (const id of ["appearance", "editor.font", "general", "general.httpProxy", "vcs.log"]) {
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

test("keeps Open project in options within narrow System Settings", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await selectPage(page, "general");
  const group = dialog.getByRole("radiogroup", { name: "Open project in", exact: true });
  const longest = group.getByRole("radio", { name: "New tab in current window", exact: true });
  await expect(longest).toBeVisible();
  await page.setViewportSize({ width: 520, height: 760 });
  const overflow = await longest.evaluate(async (radio) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const label = radio.closest("label")!;
    const group = radio.closest('[role="radiogroup"]')!;
    const text = document.createRange();
    text.selectNodeContents(label);
    return text.getBoundingClientRect().right - group.getBoundingClientRect().right;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("Git Log settings group display and column options with aligned checkboxes", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await selectPage(page, "vcs.log");
  const view = dialog.getByRole("region", { name: "View Options" });
  const columns = dialog.getByRole("region", { name: "Visible columns" });
  const tagNames = view.getByRole("checkbox", { name: "Show tag names" });
  const hash = columns.getByRole("checkbox", { name: "Hash" });
  await expect(view.getByRole("checkbox")).toHaveCount(5);
  await expect(columns.getByRole("checkbox")).toHaveCount(4);

  for (const width of [1000, 520]) {
    await page.setViewportSize({ width, height: 760 });
    // Read both rows together once the dialog has finished opening and relaid out.
    await expect
      .poll(async () => Math.abs((await tagNames.boundingBox())!.x - (await hash.boundingBox())!.x))
      .toBeLessThan(0.5);
  }

  await expect(hash).not.toBeChecked();
  await hash.focus();
  await page.keyboard.press("Space");
  await expect(hash).toBeChecked();
});

test("settings sidebar resizes with mouse and keyboard and remembers its width", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const handle = dialog.getByRole("separator", { name: "Settings pages", exact: true });
  await expect(handle).toBeVisible();
  const sidebar = dialog.locator("#navigation");
  const initial = (await sidebar.boundingBox())!.width;
  expect(initial / (await dialog.getByTestId("settings").boundingBox())!.width).toBeCloseTo(0.225, 2);
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
