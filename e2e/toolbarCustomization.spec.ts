import { expect, test } from "./fixtures";

test("Customize Main Toolbar keeps layout actions above the groups and stacks them in a narrow window", async ({
  workbench: page,
}) => {
  const open = () =>
    page.evaluate(async () => {
      const path = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ path)).executeAction("toolbar.customize");
    });
  await open();
  const dialog = page.getByRole("dialog", { name: "Customize Main Toolbar", exact: true });
  const left = dialog.getByRole("listbox", { name: "Left group" });
  const right = dialog.getByRole("listbox", { name: "Right group" });
  const add = dialog.getByRole("button", { name: "Add…", exact: true });
  const restore = dialog.getByRole("button", { name: "Restore Defaults", exact: true });
  await expect(left).toBeFocused();

  for (const width of [1120, 460]) {
    await page.setViewportSize({ width, height: 620 });
    await expect(async () => {
      const [addBox, restoreBox, leftBox, rightBox] = await Promise.all(
        [add, restore, left, right].map((el) => el.boundingBox()),
      );
      expect(addBox!.y + addBox!.height).toBeLessThan(leftBox!.y);
      expect(restoreBox!.y).toBe(addBox!.y);
      if (width === 1120) {
        expect(rightBox!.y).toBe(leftBox!.y);
        expect(rightBox!.x).toBeGreaterThan(leftBox!.x + leftBox!.width);
      } else {
        expect(rightBox!.y).toBeGreaterThan(leftBox!.y + leftBox!.height);
        expect(rightBox!.width).toBe(leftBox!.width);
      }
    }).toPass({ timeout: 3000 });
  }

  const actions = dialog.getByRole("toolbar", { name: "Toolbar actions" });
  const project = (group: typeof left) => group.getByRole("option", { name: "Project Widget", exact: true });
  await expect(project(left)).toHaveAttribute("aria-selected", "true");
  await actions.getByRole("button", { name: "Move Down" }).click();
  await expect(left.getByRole("option").nth(1)).toHaveText("Project Widget");
  await actions.getByRole("button", { name: "Move to Right" }).click();
  await expect(project(right)).toBeVisible();
  await actions.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(project(right)).toHaveCount(0);

  await add.click();
  const search = dialog.getByRole("textbox", { name: "Search actions" });
  await expect(search).toBeFocused();
  await search.fill("Project Widget");
  const available = dialog.getByRole("listbox", { name: "Actions and widgets to add" });
  await available.getByRole("option", { name: /Project Widget/ }).click();
  await expect(project(right)).toBeVisible();
  await expect(search).toHaveCount(0);

  await restore.click();
  await expect(left.getByRole("option").first()).toHaveText("Project Widget");
  await expect(project(right)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
