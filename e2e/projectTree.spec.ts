import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test("keyboard navigation: arrows move, Right/Left expand and collapse, Enter opens", async ({ workbench: page }) => {
  const tree = page.getByRole("tree", { name: "Project" });
  await page.getByRole("treeitem", { name: /acme-api/ }).click();
  const selected = tree.locator('[role="treeitem"][aria-selected="true"]');
  await expect(selected).toContainText("acme-api");

  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText("build");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText("src");

  const src = tree.getByRole("treeitem", { name: "src", exact: true });
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(src).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem", { name: "main", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("treeitem", { name: "main", exact: true })).toBeHidden();

  await page.keyboard.press("End");
  await expect(selected).toHaveText("settings.gradle.kts");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "settings.gradle.kts" }),
  ).toBeVisible();
});

test("type-ahead jumps to a matching node", async ({ workbench: page }) => {
  const tree = page.getByRole("tree", { name: "Project" });
  await page.getByRole("treeitem", { name: /acme-api/ }).click();
  await page.keyboard.type("READ");
  await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveText("README.md");
});

test("Rename targets a file or folder directly from its context menu", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  const menu = page.getByRole("menu", { name: "Context menu" });
  const dialog = page.getByRole("dialog", { name: "Rename", exact: true });
  for (const name of ["README.md", "src"]) {
    const row = page.getByRole("treeitem", { name, exact: true });
    await row.click({ button: "right" });
    await menu.getByRole("menuitem", { name: /^Rename…/ }).click();
    await expect(dialog.getByRole("textbox", { name: "New name" })).toHaveValue(name);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
  }
});

test("the file deletion form keeps its option and buttons visible in a narrow window", async ({ workbench: page }) => {
  const file = page.getByRole("treeitem", { name: "README.md", exact: true });
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Delete…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete", exact: true });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 430, height: 530 });
  await expect(dialog.locator("[data-dialog-titlebar]")).toContainText("Delete");
  await expect(dialog).toContainText("Delete 'README.md'?");
  await expect(dialog).toContainText("Items are moved to the Trash.");
  const search = dialog.getByRole("checkbox", { name: "Safe delete (with usage search)", exact: true });
  await expect(search).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  const option = await search.boundingBox();
  const footer = await dialog.locator("[data-dialog-footer]").boundingBox();
  expect(option!.y + option!.height).toBeLessThan(footer!.y);
  await search.uncheck();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1100, height: 730 });
  await expect(file).toBeVisible();
});

test("Git ignore submenu offers shared and local destinations for files and folders", async ({ workbench: page }) => {
  for (const name of ["README.md", "src"]) {
    await page.getByRole("treeitem", { name, exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Git", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Add to .gitignore", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: ".gitignore", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: ".git/info/exclude", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
});

test("keeps New open on a slow diagonal path across sibling items", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  const parent = page.getByRole("menuitem", { name: "New", exact: true });
  const box = (await parent.boundingBox())!;
  const start = { x: box.x + 20, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  const submenu = page
    .getByRole("menu")
    .filter({ has: page.getByRole("menuitem", { name: "Directory", exact: true }) });
  const target = (await submenu.getByRole("menuitem").last().boundingBox())!;
  const end = { x: target.x + 20, y: target.y + target.height / 2 };
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(start.x + ((end.x - start.x) * step) / 10, start.y + ((end.y - start.y) * step) / 10);
    await page.waitForTimeout(75);
    await expect(parent).toHaveAttribute("aria-expanded", "true");
  }
  await page.waitForTimeout(350);
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

// macOS WebKit can deliver a tap's pointerup before its pointerdown, leaving a press with no button held (#760).
const settle = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function fileRow(page: Page) {
  const file = page.getByRole("tree", { name: "Project" }).getByRole("treeitem", { name: "settings.gradle.kts" });
  await file.scrollIntoViewIfNeeded();
  const content = file.locator("[data-project-path]");
  const box = (await content.boundingBox())!;
  return {
    content,
    x: box.x + 10,
    y: box.y + box.height / 2,
    dragLabel: page.locator('body > div[aria-hidden="true"]', { hasText: "settings.gradle.kts" }),
  };
}

test("a press without a held button never starts a file drag", async ({ workbench: page }) => {
  const { content, x, y, dragLabel } = await fileRow(page);
  await content.evaluate((el) =>
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 0, pointerType: "mouse" })),
  );
  await page.mouse.move(x, y);
  await page.mouse.move(x + 60, y + 30, { steps: 5 });
  await settle(page);
  await expect(dragLabel).toHaveCount(0);
});

test("a real mouse drag still shows the drag label until release", async ({ workbench: page }) => {
  const { x, y, dragLabel } = await fileRow(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 30, { steps: 5 });
  await expect(dragLabel).toHaveCount(1);
  await page.mouse.up();
  await expect(dragLabel).toHaveCount(0);
});

test("Copy aligns the file fields and keeps the open-in-editor option in the footer", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page.keyboard.press("F5");
  const dialog = page.getByRole("dialog", { name: "Copy", exact: true });
  const name = dialog.getByRole("textbox", { name: "New name" });
  const target = dialog.getByRole("textbox", { name: "Target directory" });
  const openCopy = dialog.getByRole("checkbox", { name: "Open copy in editor" });
  await expect(name).toBeFocused();
  expect(await name.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe(
    (await name.inputValue()).replace(/\.md$/, ""),
  );
  for (const width of [1100, 430]) {
    await page.setViewportSize({ width, height: 560 });
    const [nameBox, targetBox] = await Promise.all([name.boundingBox(), target.boundingBox()]);
    expect(nameBox!.x).toBeCloseTo(targetBox!.x, 0);
    expect(targetBox!.x).toBeGreaterThan((await dialog.getByText("To directory:", { exact: true }).boundingBox())!.x);
    await expect(dialog.locator("[data-dialog-footer]").getByRole("checkbox")).toBeInViewport();
  }
  await name.fill("release-notes.md");
  await target.fill("src");
  await openCopy.check();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: "release-notes.md" })).toBeVisible();
});
