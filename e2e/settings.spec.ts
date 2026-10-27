import { expect, test } from "./fixtures";

test("⌘, opens Settings with the page tree; Escape closes", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const item = (name: string) => dialog.getByRole("treeitem", { name, exact: true });
  for (const name of ["Appearance & Behavior", "Keymap", "Editor"]) {
    await expect(item(name)).toBeVisible();
  }
  // The tree is virtualized: collapse Editor (expanded by default) so the later groups render.
  await item("Editor").click();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Editor")).not.toHaveAttribute("aria-expanded", "true");
  for (const name of ["Plugins", "Version Control"]) {
    await expect(item(name)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Language Servers page installs a tool with progress (in-memory installer)", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // The page tree is virtualized; search brings the page into view.
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Language Servers");
  await dialog.getByRole("treeitem", { name: "Language Servers", exact: true }).click();
  const list = dialog.getByRole("list", { name: /language servers/i });
  await expect(list).toBeVisible();

  await list.locator('[data-tool="gopls"]').click();
  const details = dialog.getByLabel("gopls details");
  await expect(details).toContainText("Missing");
  await details.getByRole("button", { name: "Install gopls" }).click();
  await expect(details.getByRole("progressbar", { name: "Installing gopls" })).toBeVisible();
  await expect(details).toContainText("Installed");
  await expect(details).toContainText("1.0.0");
  await expect(details.getByRole("button", { name: "Uninstall" })).toBeVisible();

  // Tools without an installer explain how to get them.
  await list.locator('[data-tool="solargraph"]').click();
  await expect(dialog.getByLabel("solargraph details")).toContainText("gem install solargraph");
});
