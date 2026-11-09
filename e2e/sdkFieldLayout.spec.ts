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
    const combo = await interpreter.boundingBox();
    const button = await add.boundingBox();
    const row = await add.evaluate((el) => {
      const r = el.parentElement!.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(combo!.width).toBeGreaterThan(20);
    expect(combo!.x).toBeGreaterThanOrEqual(row.left - 1);
    expect(combo!.x + combo!.width).toBeLessThanOrEqual(row.right + 1);
    expect(button!.x + button!.width).toBeLessThanOrEqual(row.right + 1);
    const overlap =
      Math.min(combo!.x + combo!.width, button!.x + button!.width) > Math.max(combo!.x, button!.x) &&
      Math.min(combo!.y + combo!.height, button!.y + button!.height) > Math.max(combo!.y, button!.y);
    expect(overlap).toBe(false);
  }
});
