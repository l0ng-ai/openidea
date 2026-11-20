import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openSaveActions(page: Page) {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Optimize imports");
  await settings.getByRole("treeitem", { name: "Actions on Save", exact: true }).click();
  await search.clear();
  return settings;
}

test("Actions on Save aligns each enabled action with its trigger in wide and narrow panes", async ({
  workbench: page,
}) => {
  const settings = await openSaveActions(page);
  const table = settings.getByRole("table", { name: "Actions on Save", exact: true });
  const action = table.getByRole("columnheader", { name: "Action", exact: true });
  const heading = table.getByRole("columnheader", { name: "Activated on", exact: true });
  const format = table.getByRole("row", { name: /Reformat code/ });
  const imports = table.getByRole("row", { name: /Optimize imports/ });
  const cleanup = table.getByRole("row", { name: /Run code cleanup/ });
  const trigger = (action: typeof format) => action.getByRole("cell").nth(1);
  await expect(table.getByRole("row")).toHaveCount(4);
  await format.getByRole("checkbox").check();
  await imports.getByRole("checkbox").press("Space");
  await expect(trigger(format)).toHaveText("Save or Save All");
  await expect(trigger(imports)).toHaveText("Save or Save All");
  await expect(trigger(cleanup)).toBeEmpty();

  for (const width of [1120, 520]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(trigger(imports)).toBeInViewport({ ratio: 1 });
    const column = (await heading.boundingBox())!;
    expect((await action.boundingBox())!.width).toBeGreaterThan(column.width);
    expect(
      await trigger(imports).evaluate((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell.firstElementChild!);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    for (const row of [format, imports, cleanup]) {
      const cell = (await trigger(row).boundingBox())!;
      expect(Math.abs(column.x - cell.x)).toBeLessThan(1);
      expect(Math.abs(column.width - cell.width)).toBeLessThan(1);
    }
    expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(settings.getByRole("button", { name: "Editor › General", exact: true })).toBeInViewport();
  }

  await format.getByRole("checkbox").uncheck();
  await expect(trigger(format)).toBeEmpty();
  await expect(trigger(imports)).toHaveText("Save or Save All");
});

test("Actions on Save stages the same preferences as Editor General and honors Apply and Cancel", async ({
  workbench: page,
}) => {
  const settings = await openSaveActions(page);
  const format = settings.getByRole("checkbox", { name: "Reformat code", exact: true });
  const imports = settings.getByRole("checkbox", { name: "Optimize imports", exact: true });
  const cleanup = settings.getByRole("checkbox", { name: "Run code cleanup", exact: true });
  const apply = settings.getByRole("button", { name: "Apply", exact: true });
  const cancel = settings.getByRole("button", { name: "Cancel", exact: true });
  await format.check();
  await imports.check();
  await settings.getByRole("button", { name: "Editor › General", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "Reformat code on save", exact: true })).toBeChecked();
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect(format).toBeChecked();
  await expect(imports).toBeChecked();
  await apply.click();
  await expect(apply).toBeDisabled();
  await cancel.click();

  await openSaveActions(page);
  await expect(format).toBeChecked();
  await expect(imports).toBeChecked();
  await cleanup.check();
  await cancel.click();
  await openSaveActions(page);
  await expect(cleanup).not.toBeChecked();
  await expect(format).toBeChecked();
  await expect(imports).toBeChecked();
});
