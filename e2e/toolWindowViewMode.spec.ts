import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

const project = (page: Page) => page.locator('[data-toolwindow="project"]');
const editorArea = (page: Page) => page.locator("[data-editor-area]");

async function setViewMode(page: Page, mode: "Dock Pinned" | "Dock Unpinned" | "Undock") {
  await project(page).getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitem", { name: "View Mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: mode }).click();
}

test("Undock shows the Project window over the editor; focusing the editor hides it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const docked = (await editorArea(page).boundingBox())!;

  await setViewMode(page, "Undock");
  await expect(project(page)).toBeVisible();
  const area = (await editorArea(page).boundingBox())!;
  // The editor takes the Project window's place and keeps it while the window shows over it.
  expect(area.x).toBeLessThan(docked.x);
  expect(area.width).toBeGreaterThan(docked.width);
  const over = (await project(page).boundingBox())!;
  expect(over.x + over.width).toBeGreaterThan(area.x + 100);

  // Its inner edge resizes it over the editor.
  const edge = (await page.getByRole("separator", { name: "Resize undocked left tool window" }).boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 100, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();
  expect((await project(page).boundingBox())!.width).toBeCloseTo(over.width + 100, -1);
  expect(await editorArea(page).boundingBox()).toEqual(area);

  // Right of the window, which covers the editor's left part.
  const content = editor.locator(".cm-content");
  await content.click({ position: { x: (await content.boundingBox())!.width * 0.75, y: 40 } });
  await expect(project(page)).toBeHidden();
  expect(await editorArea(page).boundingBox()).toEqual(area);

  await page.keyboard.press("Meta+1");
  await expect(project(page)).toBeVisible();
  await expect(page.getByRole("tree", { name: "Project" })).toBeFocused();
  expect(await editorArea(page).boundingBox()).toEqual(area);
});

test("a menu opened from an undocked window leaves it open", async ({ workbench: page }) => {
  await setViewMode(page, "Undock");
  await project(page).getByRole("button", { name: "Options" }).click();
  await expect(page.getByRole("menuitem", { name: "View Mode" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(project(page)).toBeVisible();
  await page.getByRole("treeitem", { name: /acme-api/ }).click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(project(page)).toBeVisible();
});

test("Dock Unpinned docks the window and hides it when another tool window takes focus", async ({
  workbench: page,
}) => {
  const docked = (await editorArea(page).boundingBox())!;
  await setViewMode(page, "Dock Unpinned");
  expect(await editorArea(page).boundingBox()).toEqual(docked);

  await page.getByRole("tree", { name: "Project" }).focus();
  await page.keyboard.press("Meta+6");
  await expect(page.locator('[data-toolwindow="problems"]')).toBeVisible();
  await expect(project(page)).toBeHidden();

  // Back to Dock Pinned: the window stays when focus moves on.
  await page.keyboard.press("Meta+1");
  await setViewMode(page, "Dock Pinned");
  await page.keyboard.press("Meta+6");
  await expect(project(page)).toBeVisible();
});
