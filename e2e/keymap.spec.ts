import { expect, test } from "./fixtures";

test("records double-modifier gestures in the shortcut filter and assignment dialog", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  const filterToggle = settings.getByRole("button", { name: "Find Actions by Shortcut", exact: true });
  await filterToggle.click();
  const filter = settings.getByRole("textbox", { name: "Find actions by shortcut", exact: true });
  await expect(filter).toBeFocused();
  await page.keyboard.press("Shift");
  await page.keyboard.press("Control");
  await page.keyboard.press("Shift");
  await expect(filter).toHaveText("Press a shortcut to find actions");
  await page.keyboard.press("Shift");
  await expect(filter).toHaveText("⇧⇧");
  const actions = settings.getByRole("tree", { name: "Actions" });
  await expect(actions.getByRole("treeitem", { name: /Search Everywhere/ })).toBeVisible();
  await expect(actions.getByRole("treeitem", { name: /Find Action/ })).toHaveCount(0);

  await filterToggle.click();
  await settings.getByRole("textbox", { name: "Search actions" }).fill("Find Action");
  await actions.getByRole("treeitem", { name: /Find Action/ }).click();
  await settings.getByRole("button", { name: "Add Keyboard Shortcut", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcut: Find Action…", exact: true });
  const first = dialog.getByRole("textbox", { name: "First stroke" });
  const secondToggle = dialog.getByRole("checkbox", { name: "Second stroke:" });
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  await secondToggle.click();
  await first.click();
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");
  await expect(first).toHaveText("⌃⌃");
  await expect(secondToggle).toBeDisabled();
  await expect(dialog.getByText("Run Anything…", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Run Anything", exact: true })).toHaveCount(0);
  await expect(ok).toBeEnabled();

  await page.keyboard.press("Alt");
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Alt");
  await expect(first).toHaveText("⌥⌥↑");
  await expect(ok).toBeEnabled();

  await page.keyboard.press("Meta+k");
  const second = dialog.getByRole("textbox", { name: "Second stroke" });
  await second.click();
  await page.keyboard.press("Meta+i");
  await expect(first).toHaveText("⌘K");
  await expect(second).toHaveText("⌘I");
  await expect(ok).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

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

test("rectangular drag remains configurable after removal and saves a middle mouse binding", async ({
  workbench: page,
}) => {
  const title = "Create Rectangular Selection on Mouse Drag";
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  await settings.getByRole("textbox", { name: "Search actions", exact: true }).fill(title);
  const row = settings.getByRole("tree", { name: "Actions" }).getByRole("treeitem", { name: new RegExp(title) });
  for (let i = 0; i < 2; i++) {
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: /^Remove / })
      .first()
      .click();
  }
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Mouse Shortcut", exact: true }).click();
  const recorder = page.getByRole("dialog", { name: `Mouse Shortcut: ${title}`, exact: true });
  await recorder.getByRole("textbox", { name: "Mouse shortcut" }).click({ button: "middle", modifiers: ["Alt"] });
  await expect(recorder.getByRole("textbox", { name: "Mouse shortcut" })).toContainText("Middle Click");
  await recorder.getByRole("button", { name: "OK", exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const keymapModule = "/src/platform/keymap.ts";
        const { bindingsFor } = await import(/* @vite-ignore */ keymapModule);
        return bindingsFor("editor.createRectangularSelectionOnMouseDrag");
      }),
    )
    .toEqual(["Alt+Button2"]);
  await page.keyboard.press("Meta+,");
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  await settings.getByRole("textbox", { name: "Search actions", exact: true }).fill(title);
  await expect(row).toContainText("Middle Click");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("the action search also finds actions by typed shortcut text", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  const search = settings.getByRole("textbox", { name: "Search actions", exact: true });
  const actions = settings.getByRole("tree", { name: "Actions" });
  const goToFile = actions.getByRole("treeitem", { name: /Go to File/ });
  for (const query of ["cmd+shift+o", "Shift+Meta+O", "⇧⌘O"]) {
    await search.fill(query);
    await expect(goToFile).toBeVisible();
    await expect(actions.getByRole("treeitem", { name: /Recent Files/ })).toHaveCount(0);
  }
  const shots = process.env.OPENIDEA_E2E_SHOTS;
  if (shots) await settings.screenshot({ path: `${shots}/after.png`, animations: "disabled" });
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
});
