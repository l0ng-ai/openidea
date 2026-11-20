import { expect, test } from "./fixtures";

test("Select In names the chooser and reveals the file in the requested project view", async ({ workbench: page }) => {
  const tree = page.getByRole("tree", { name: "Project", exact: true });
  await tree.getByRole("treeitem", { name: "settings.gradle.kts", exact: true }).dblclick();
  await expect(page.locator(".cm-content")).toBeVisible();

  const openChooser = () =>
    page.evaluate(async () => {
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("navigate.selectIn");
    });
  await openChooser();
  const menu = page.getByRole("menu", { name: "Select In", exact: true });
  await expect(menu.getByText("Select In", { exact: true })).toBeVisible();
  const project = menu.getByRole("menuitem", { name: "Project View", exact: true });
  await expect(project).toBeFocused();
  await expect(project.locator('[data-menu-number="1"]')).toBeVisible();

  await page.keyboard.press("ArrowRight");
  const projectFiles = page.getByRole("menuitem", { name: "Project Files", exact: true });
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await expect(projectFiles).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open Files", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "All Changed Files", exact: true })).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(projectFiles).toBeHidden();
  await expect(project).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(projectFiles).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Project Files", exact: true })).toBeVisible();
  const file = tree.getByRole("treeitem", { name: "settings.gradle.kts", exact: true });
  await expect(file).toHaveAttribute("aria-selected", "true");

  await page.locator(".cm-content").focus();
  await openChooser();
  await expect(project).toBeFocused();
  await project.locator("[data-menu-submenu-arrow]").click();
  await expect(projectFiles).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(project).toBeFocused();
  await page.keyboard.press("1");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Project Files", exact: true })).toBeVisible();
  await expect(file).toHaveAttribute("aria-selected", "true");
});
