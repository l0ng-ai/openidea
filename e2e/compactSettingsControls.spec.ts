import { expect, test } from "./fixtures";

for (const [id, selector] of [
  ["general", "[class*='radios'] label"],
  ["notifications", "table tbody td:first-child"],
  ["keymap", "[class*='presetLabel']"],
  ["editor.inspections", "[class*='profileRow'] > span:first-child"],
  ["vcs.issueNavigation", "[class*='pageBody'] button:not([aria-label])"],
]) {
  test(`${id} keeps compact labels inside their controls`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.evaluate(async (id) => {
      const localePath = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ localePath)).setLocale("zh");
      const stagingPath = "/src/features/settings/model/staging.ts";
      (await import(/* @vite-ignore */ stagingPath)).selectPage(id);
    }, id);
    const labels = dialog.locator(selector);
    await expect(labels.first()).toBeVisible();
    for (const width of [1000, 640, 520]) {
      await page.setViewportSize({ width, height: 760 });
      const fits = await labels.evaluateAll((labels) =>
        labels.every((label) => {
          const box = label.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(label);
          const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          return (
            lines.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.height <= 24) &&
            Math.max(...lines.map((r) => r.bottom)) - Math.min(...lines.map((r) => r.top)) <= 24
          );
        }),
      );
      expect(fits).toBe(true);
    }
  });
}

for (const [id, selector] of [
  ["general", "[class*='fontRow'] > label"],
  ["build.console", "[class*='inlineRow'] > label"],
]) {
  test(`${id} keeps a readable width for inline text`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(async (id) => {
      const localePath = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ localePath)).setLocale("zh");
      const path = "/src/features/settings/model/staging.ts";
      (await import(/* @vite-ignore */ path)).selectPage(id);
    }, id);
    const text = page.locator(selector).first();
    await expect(text).toBeVisible();
    await page.setViewportSize({ width: 520, height: 760 });
    expect((await text.boundingBox())!.width).toBeGreaterThan(100);
  });
}
