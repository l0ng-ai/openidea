import { expect, test } from "./fixtures";

for (const [id, key, name] of [
  ["languages.node", "languages.node.interpreter", "Node interpreter"],
  ["languages.java", "languages.java.jdk", "Project JDK"],
  ["languages.php", "languages.php.interpreter", "PHP interpreter"],
]) {
  test(`${name} dropdown keeps long custom paths inside the viewport`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    const value = "/project/" + "long-path/".repeat(30) + "runtime";
    await page.evaluate(
      async ({ id, key, value }) => {
        const path = "/src/features/settings/model/staging.ts";
        const { selectPage, stage } = await import(/* @vite-ignore */ path);
        stage(id, "project", key, value);
        selectPage(id);
      },
      { id, key, value },
    );
    const combo = page.getByRole("button", { name, exact: true });
    for (const width of [1000, 640, 520]) {
      await page.setViewportSize({ width, height: 760 });
      await combo.click();
      const list = page.getByRole("listbox", { name, exact: true });
      await expect(list).toBeVisible();
      await expect
        .poll(() =>
          list.evaluate((list) => {
            const popup = list.closest("[data-popup]")!;
            const r = popup.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth && list.scrollWidth <= list.clientWidth + 1;
          }),
        )
        .toBe(true);
      const option = list.getByRole("option").filter({ hasText: value });
      await expect(option).toBeVisible();
      await expect(option.locator("[title]").first()).toHaveAttribute("title", value);
      await option.click();
      await expect(list).toHaveCount(0);
      await expect(combo).toHaveText(value);
    }
  });
}
