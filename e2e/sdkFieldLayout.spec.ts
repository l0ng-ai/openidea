import { expect, test } from "./fixtures";

for (const [id, key, name] of [
  ["languages.node", "languages.node.interpreter", "Node interpreter"],
  ["languages.java", "languages.java.jdk", "Project JDK"],
  ["languages.php", "languages.php.interpreter", "PHP interpreter"],
]) {
  test(`${name} keeps its value and browse controls inside their field`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(
      async ({ id, key }) => {
        const path = "/src/features/settings/model/staging.ts";
        const { selectPage, stage } = await import(/* @vite-ignore */ path);
        stage(id, "project", key, "/project/" + "long-path/".repeat(15) + "runtime");
        selectPage(id);
      },
      { id, key },
    );
    const combo = page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name, exact: true });
    await expect(combo).toBeVisible();
    for (const width of [1000, 800, 520]) {
      await page.setViewportSize({ width, height: 760 });
      const geometry = await combo.evaluate((el) => {
        const field = el.parentElement!;
        const bounds = field.getBoundingClientRect();
        return [...field.querySelectorAll("button")].map((button) => {
          const r = button.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            width: r.width,
            fieldLeft: bounds.left,
            fieldRight: bounds.right,
            fits: r.width > 0 && r.left >= bounds.left - 1 && r.right <= bounds.right + 1,
          };
        });
      });
      expect(
        geometry.every((r) => r.fits),
        JSON.stringify({ width, geometry }),
      ).toBe(true);
    }
  });
}

test("Python interpreter controls stay separate and visible in a narrow settings pane", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    const { selectPage, stage } = await import(/* @vite-ignore */ path);
    stage(
      "python.interpreter",
      "project",
      "languages.python.interpreter",
      "/project/" + "long-path/".repeat(15) + "python",
    );
    selectPage("python.interpreter");
  });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const interpreter = dialog.getByRole("button", { name: "Python interpreter", exact: true });
  const add = dialog.getByRole("button", { name: "Add Interpreter…", exact: true });
  await expect(interpreter).toBeVisible();
  for (const width of [1000, 800, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await expect
      .poll(() =>
        add.evaluate((el) => {
          const row = el.parentElement!;
          const bounds = row.getBoundingClientRect();
          const combo = row.querySelector('[aria-label="Python interpreter"]')!.getBoundingClientRect();
          const button = el.getBoundingClientRect();
          return {
            comboFits: combo.width > 20 && combo.left >= bounds.left - 1 && combo.right <= bounds.right + 1,
            buttonFits: button.left >= bounds.left - 1 && button.right <= bounds.right + 1,
            overlaps:
              Math.min(combo.right, button.right) > Math.max(combo.left, button.left) &&
              Math.min(combo.bottom, button.bottom) > Math.max(combo.top, button.top),
          };
        }),
      )
      .toEqual({ comboFits: true, buttonFits: true, overlaps: false });
  }
});
