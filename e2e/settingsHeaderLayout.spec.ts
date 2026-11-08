import { expect, test } from "./fixtures";

test("dirty settings keep scope labels and navigation inside the page header", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    const { selectPage, stage } = await import(/* @vite-ignore */ path);
    stage("languages.node", "project", "languages.node.interpreter", "/custom/node");
    selectPage("languages.node");
  });
  const scope = page.getByRole("radiogroup", { name: "Settings scope" });
  const reset = page.getByRole("button", { name: "Reset", exact: true });
  await expect(reset).toBeVisible();
  for (const width of [1000, 640, 520]) {
    await page.setViewportSize({ width, height: 760 });
    const fits = await scope.evaluate((scope) => {
      const header = scope.parentElement!;
      const bounds = header.getBoundingClientRect();
      return [...header.querySelectorAll("button")].every((button) => {
        const box = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        return (
          box.left >= bounds.left &&
          box.right <= bounds.right &&
          [...range.getClientRects()].every((r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1)
        );
      });
    });
    expect(fits).toBe(true);
  }
  await reset.click();
  await expect(reset).toHaveCount(0);
  await expect(scope.getByRole("radio", { name: "This project" })).toBeVisible();
});
