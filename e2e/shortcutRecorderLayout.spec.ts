import { expect, test } from "./fixtures";

test("shortcut assignment fits the first stroke and conflict names in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 336, height: 540 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  await settings.getByRole("textbox", { name: "Search actions" }).fill("Find Action");
  const action = settings.getByRole("treeitem", { name: /Find Action/ });
  await action.click();
  await settings.getByRole("button", { name: "Add Keyboard Shortcut", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcut: Find Action…", exact: true });
  const first = dialog.getByRole("textbox", { name: "First stroke" });
  const body = dialog.locator("[data-dialog-body]");
  const titleBar = dialog.locator("[data-dialog-titlebar]");
  await expect(first).toBeFocused();
  await expect(titleBar).toHaveText("Keyboard Shortcut");
  await expect(body.getByText("Find Action…", { exact: true })).toBeVisible();
  const firstBounds = (await first.boundingBox())!;
  const bodyBounds = (await body.boundingBox())!;
  expect(firstBounds.width).toBeGreaterThan(bodyBounds.width - 32);
  const conflicts = dialog.getByRole("list", { name: "Conflicts:" });
  await expect(conflicts).toHaveCount(0);

  await first.press("Meta+Alt+L");
  await expect(conflicts).toBeVisible();
  await expect(conflicts.getByRole("listitem").filter({ hasText: "Reformat Code" }).first()).toBeVisible();
  expect(await conflicts.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(
    await conflicts
      .getByRole("listitem")
      .evaluateAll((rows) => rows.every((row) => row.scrollHeight <= row.clientHeight)),
  ).toBe(true);
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  await ok.click();
  const confirmation = page.getByRole("dialog", { name: "Warning", exact: true });
  await expect(confirmation.getByRole("list").getByText("Reformat Code", { exact: true })).toHaveCount(2);
  await confirmation.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(action.locator("kbd").filter({ hasText: "⌥⌘L" })).toHaveCount(1);
});
