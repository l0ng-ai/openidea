import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openFileColors(page: Page) {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Use in project view");
  await settings.getByRole("treeitem", { name: "File Colors", exact: true }).click();
  await search.clear();
  return settings;
}

test("File Colors fits its switches and keeps the toolbar and table headings in view", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  const settings = await openFileColors(page);
  const table = settings.getByRole("table", { name: "File colors", exact: true });
  const scope = table.getByRole("columnheader", { name: "Scope", exact: true });
  const color = table.getByRole("columnheader", { name: "Color", exact: true });
  const toolbar = settings.getByRole("toolbar", { name: "File colors actions", exact: true });
  const master = settings.getByRole("checkbox", { name: "Enable file colors", exact: true });
  const project = settings.getByRole("checkbox", { name: "Use in project view", exact: true });
  const hex = settings.getByRole("textbox", { name: "Custom colour hex", exact: true });

  await expect(scope).toBeVisible();
  expect(Math.abs((await master.boundingBox())!.y - (await project.boundingBox())!.y)).toBeLessThan(1);

  for (const width of [1120, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(project).toBeInViewport({ ratio: 1 });
    await expect(color).toBeInViewport({ ratio: 1 });
    await expect(hex).toBeInViewport({ ratio: 1 });
    expect((await hex.boundingBox())!.width).toBeGreaterThan(70);
    expect((await color.boundingBox())!.width).toBeGreaterThan(80);
    const cell = table.getByRole("cell", { name: "Green", exact: true });
    expect(Math.abs((await color.boundingBox())!.x - (await cell.boundingBox())!.x)).toBeLessThan(1);
  }

  const add = toolbar.getByRole("button", { name: "Add", exact: true });
  for (let i = 0; i < 10; i++) await add.click();
  const last = table.getByRole("row").last();
  await expect(last.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(scope).toBeInViewport({ ratio: 1 });
  await expect(toolbar).toBeInViewport({ ratio: 1 });
});

test("File Colors preserves ordered rules and placement settings across Apply and Cancel", async ({
  workbench: page,
}) => {
  const settings = await openFileColors(page);
  const table = settings.getByRole("table", { name: "File colors", exact: true });
  const tests = table.getByRole("button", { name: "Tests", exact: true });
  const firstRule = table.getByRole("row").nth(1);
  const toolbar = settings.getByRole("toolbar", { name: "File colors actions", exact: true });
  const tabs = settings.getByRole("checkbox", { name: "Use in editor tabs", exact: true });
  const master = settings.getByRole("checkbox", { name: "Enable file colors", exact: true });
  const apply = settings.getByRole("button", { name: "Apply", exact: true });
  const cancel = settings.getByRole("button", { name: "Cancel", exact: true });

  await tabs.uncheck();
  await master.uncheck();
  await expect(tabs).toBeDisabled();
  await master.check();
  await expect(tabs).not.toBeChecked();
  await expect(tabs).toBeEnabled();
  await tests.press("Enter");
  await expect(tests).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("textbox", { name: "Custom colour hex", exact: true }).fill("#1258a5");
  await toolbar.getByRole("button", { name: "Move Up", exact: true }).click();
  await expect(firstRule.getByRole("button", { name: "Tests", exact: true })).toBeVisible();
  await expect(firstRule.getByRole("cell", { name: "#1258a5", exact: true })).toBeVisible();
  await apply.click();
  await expect(apply).toBeDisabled();
  await cancel.click();

  await openFileColors(page);
  await expect(tabs).not.toBeChecked();
  await expect(firstRule.getByRole("cell", { name: "#1258a5", exact: true })).toBeVisible();
  const remove = toolbar.getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  await remove.click();
  await expect(table.getByText("No file colors. Click + to add one.", { exact: true })).toBeVisible();
  await expect(remove).toBeDisabled();
  await cancel.click();
  await openFileColors(page);
  await expect(firstRule.getByRole("cell", { name: "#1258a5", exact: true })).toBeVisible();
});
