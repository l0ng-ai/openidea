/**
 * IDEA's Compare With…: project tree (git and non-git projects alike), the
 * editor content menu and the editor tab menu. Outside the desktop app the OS
 * dialog is replaced by a browser file picker and the chosen file is compared
 * as text.
 */
import { expect, openFromTree, test } from "./fixtures";

test("project tree menu offers Compare With… for a file", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  // The accessible name carries the shortcut: "Compare With… ⌘D".
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("editor tab menu offers Compare With…", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await page
    .getByRole("tablist", { name: "Editor tabs" })
    .getByRole("tab", { name: "README.md" })
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("editor menu offers Compare With…", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Compare with Clipboard", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Compare With… compares against a file picked in the browser", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /^Compare With…/ }).click();
  await (await chooser).setFiles({ name: "other.md", mimeType: "text/markdown", buffer: Buffer.from("other text\n") });
  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(tabs.getByRole("tab", { name: /other\.md/ })).toBeVisible({ timeout: 15_000 });
});
