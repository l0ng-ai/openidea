import { expect, test } from "./fixtures";

for (const activation of ["double-click", "Enter"] as const) {
  test(`Keymap ${activation} offers mouse and keyboard shortcuts`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
    await settings.getByRole("textbox", { name: "Search actions", exact: true }).fill("Find Action");
    const row = settings.getByRole("tree", { name: "Actions" }).getByRole("treeitem", { name: /Find Action/ });
    const activate = async () => {
      if (activation === "double-click") await row.dblclick();
      else {
        await row.click();
        await page.keyboard.press("Enter");
      }
    };
    await activate();
    const keyboard = page.getByRole("menuitem", { name: "Add Keyboard Shortcut", exact: true });
    await expect(keyboard).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Add Mouse Shortcut", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const mouseDialog = page.getByRole("dialog", { name: "Mouse Shortcut: Find Action…", exact: true });
    await mouseDialog.getByRole("textbox", { name: "Mouse shortcut" }).click({ modifiers: ["Alt"] });
    await expect(mouseDialog.getByRole("button", { name: "OK", exact: true })).toBeEnabled();
    await mouseDialog.getByRole("button", { name: "OK", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Warning", exact: true })
      .getByRole("button", { name: "Leave", exact: true })
      .click();
    await expect(row).toContainText("Click");
    await activate();
    await keyboard.click();
    const keyboardDialog = page.getByRole("dialog", { name: "Keyboard Shortcut: Find Action…", exact: true });
    await expect(keyboardDialog.getByRole("textbox", { name: "First stroke" })).toBeFocused();
    await keyboardDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.click({ button: "right" });
    await expect(keyboard).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Add Mouse Shortcut", exact: true })).toBeVisible();
  });
}
