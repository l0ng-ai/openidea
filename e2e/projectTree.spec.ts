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
