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
  const center = dialog.getByRole("listbox", { name: "Center group" });
  const right = dialog.getByRole("listbox", { name: "Right group" });
  const add = dialog.getByRole("button", { name: "Add…", exact: true });
  const restore = dialog.getByRole("button", { name: "Restore Defaults", exact: true });
  await expect(left).toBeFocused();

  for (const width of [1120, 460]) {
    await page.setViewportSize({ width, height: 620 });
    await expect(async () => {
      const [addBox, restoreBox, leftBox, centerBox, rightBox] = await Promise.all(
        [add, restore, left, center, right].map((el) => el.boundingBox()),
      );
      expect(addBox!.y + addBox!.height).toBeLessThan(leftBox!.y);
      expect(restoreBox!.y).toBe(addBox!.y);
      if (width === 1120) {
        expect(centerBox!.y).toBe(leftBox!.y);
        expect(rightBox!.y).toBe(leftBox!.y);
        expect(centerBox!.x).toBeGreaterThan(leftBox!.x + leftBox!.width);
        expect(rightBox!.x).toBeGreaterThan(centerBox!.x + centerBox!.width);
      } else {
        expect(centerBox!.y).toBeGreaterThan(leftBox!.y + leftBox!.height);
        expect(rightBox!.y).toBeGreaterThan(centerBox!.y + centerBox!.height);
        expect(rightBox!.width).toBe(leftBox!.width);
      }
    }).toPass({ timeout: 3000 });
  }

  const actions = dialog.getByRole("toolbar", { name: "Toolbar actions" });
  const project = (group: typeof left) => group.getByRole("option", { name: "Project Widget", exact: true });
  await expect(project(left)).toHaveAttribute("aria-selected", "true");
  await actions.getByRole("button", { name: "Move Down" }).click();
  await expect(left.getByRole("option").nth(1)).toHaveText("Project Widget");
  // Left has nothing further left; the arrows step through Center to Right and back.
  await expect(actions.getByRole("button", { name: "Move to Left" })).toBeDisabled();
  await actions.getByRole("button", { name: "Move to Center" }).click();
  await expect(project(center)).toBeVisible();
  await actions.getByRole("button", { name: "Move to Right" }).click();
  await expect(project(right)).toBeVisible();
  await expect(actions.getByRole("button", { name: "Move to Right" })).toBeDisabled();
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

test("the Center group is centred in the main toolbar", async ({ workbench: page }) => {
  const bar = page
    .locator("header")
    .filter({ has: page.locator("[data-toolbar-spacer]") })
    .first();
  await expect(bar.locator("[data-toolbar-center]")).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        appearance: {
          ...settings?.appearance,
          mainToolbar: { left: [], center: ["project"], right: ["action:navigate.searchEverywhere"], hidden: [] },
        },
      },
    });
  });
  const group = bar.locator("[data-toolbar-center]");
  await expect(group).toContainText("acme-api");
  for (const width of [1400, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(async () => {
      const [barBox, groupBox] = await Promise.all([bar.boundingBox(), group.boundingBox()]);
      const middle = groupBox!.x + groupBox!.width / 2;
      expect(Math.abs(middle - (barBox!.x + barBox!.width / 2))).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 3000 });
  }
  await page.screenshot({ path: "test-results/toolbar-center.png", animations: "disabled" });
});

test("the project colour gradient follows the Project widget", async ({ workbench: page }) => {
  const frame = page.locator("[data-project-frame]");
  const icon = page.locator("header [data-project-widget-icon]").first();
  const anchor = () => frame.evaluate((el) => el.style.getPropertyValue("--project-gradient-x"));
  const iconCenter = async () => {
    const [frameBox, iconBox] = await Promise.all([frame.boundingBox(), icon.boundingBox()]);
    return Math.round(iconBox!.x + iconBox!.width / 2 - frameBox!.x);
  };
  await expect(icon).toBeVisible();
  await expect.poll(anchor).toBe(`${await iconCenter()}px`);

  const layout = async (mainToolbar: object) =>
    page.evaluate(async (mainToolbar) => {
      const path = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ path);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, appearance: { ...settings?.appearance, mainToolbar } } });
    }, mainToolbar);
  await layout({ left: [], center: ["project"], right: ["action:navigate.searchEverywhere"], hidden: [] });
  for (const width of [1400, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(async () => {
      const x = await iconCenter();
      expect(Math.abs(x - width / 2)).toBeLessThan(150);
      expect(await anchor()).toBe(`${x}px`);
    }).toPass({ timeout: 3000 });
  }
  await page.screenshot({ path: "test-results/project-gradient-center.png", animations: "disabled" });

  // Without the widget the gradient goes back to the frame's corner.
  await layout({ left: [], center: [], right: ["action:navigate.searchEverywhere"], hidden: ["project"] });
  await expect(icon).toHaveCount(0);
  await expect.poll(anchor).toBe("");
});
