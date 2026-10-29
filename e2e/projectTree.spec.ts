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
