import { expect, test } from "./fixtures";

test("postfix template descriptions remain inside their rows", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage("editor.general.postfixCompletion");
  });
  const rows = page.getByRole("list", { name: "Postfix templates" }).getByRole("listitem");
  await expect(rows.first()).toBeVisible();
  for (const language of ["JavaScript / TypeScript", "Rust", "Python", "Go", "Java", "Kotlin"]) {
    await page.getByRole("tab", { name: language, exact: true }).click();
    for (const width of [1000, 640, 520]) {
      await page.setViewportSize({ width, height: 760 });
      const fits = await rows.evaluateAll((rows) =>
        rows.every((row) => {
          const bounds = row.getBoundingClientRect();
          const detail = row.lastElementChild!;
          const range = document.createRange();
          range.selectNodeContents(detail);
          return [...range.getClientRects()].every((r) => r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1);
        }),
      );
      expect(fits).toBe(true);
    }
  }
});
