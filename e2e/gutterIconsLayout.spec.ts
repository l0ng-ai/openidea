import { expect, test } from "./fixtures";

test("gutter icon previews align in narrow settings and the master switch keeps each choice", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Color preview");
  await settings.getByRole("treeitem", { name: "Gutter Icons", exact: true }).click();
  await page.setViewportSize({ width: 520, height: 620 });

  const list = settings.getByRole("list", { name: "Gutter Icons", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(list.locator("mark")).toHaveText(["Color", "preview"]);
  const layout = await list.getByRole("listitem").evaluateAll((rows) =>
    rows.map((row) => {
      const preview = row.firstElementChild!.getBoundingClientRect();
      const input = row.querySelector("input")!.getBoundingClientRect();
      return { x: input.x, previewRight: preview.right, overflow: row.scrollWidth - row.clientWidth };
    }),
  );
  for (const row of layout) {
    expect(row.previewRight).toBeLessThan(row.x);
    expect(row.x).toBeCloseTo(layout[0]!.x, 0);
    expect(row.overflow).toBeLessThanOrEqual(1);
  }

  const master = settings.getByRole("checkbox", { name: "Show gutter icons", exact: true });
  const color = list.getByRole("checkbox", { name: "Color preview", exact: true });
  await color.uncheck();
  await master.uncheck();
  for (const option of await list.getByRole("checkbox").all()) await expect(option).toBeDisabled();
  await master.check();
  await expect(color).toBeEnabled();
  await expect(color).not.toBeChecked();
  await expect(list.getByRole("checkbox", { name: "Bookmarks", exact: true })).toBeChecked();
});
