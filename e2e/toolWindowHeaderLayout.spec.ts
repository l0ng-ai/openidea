import { expect, openFromTree, test } from "./fixtures";

test("tool window header keeps its actions visible as the Project pane narrows", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  const project = page.locator('[data-toolwindow="project"]');
  const header = project.locator("header");
  await header.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Project Files", exact: true }).click();

  const title = header.getByRole("button", { name: "Project Files", exact: true });
  const options = header.getByRole("button", { name: "Options", exact: true });
  const hide = header.getByRole("button", { name: "Hide", exact: true });
  await expect(title).toHaveCSS("font-size", "13px");
  const resize = (width: number) =>
    page.evaluate(async (width) => {
      const path = "/src/workbench/toolwindows/store.ts";
      (await import(/* @vite-ignore */ path)).setToolWindowSize("left", width);
    }, width);
  await resize(168);
  await expect
    .poll(
      () =>
        header.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("button")].every((button) => {
            const box = button.getBoundingClientRect();
            return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right;
          });
        }),
      { message: "All header buttons fit inside the narrow Project tool window" },
    )
    .toBe(true);
  expect(await title.getByText("Project Files").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await title.press("Enter");
  await expect(page.getByRole("menu", { name: "Project views" })).toBeVisible();
  await page.keyboard.press("Escape");

  await options.press("Enter");
  await expect(page.getByRole("menu", { name: "Project options" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();

  await resize(110);
  const collapse = header.getByRole("button", { name: "Collapse All", exact: true });
  await collapse.focus();
  await expect
    .poll(async () => {
      const [pane, collapseBox, optionsBox, hideBox] = await Promise.all([
        header.boundingBox(),
        collapse.boundingBox(),
        options.boundingBox(),
        hide.boundingBox(),
      ]);
      return (
        !!pane &&
        !!collapseBox &&
        !!optionsBox &&
        !!hideBox &&
        collapseBox.x >= pane.x &&
        collapseBox.x + collapseBox.width <= optionsBox.x &&
        hideBox.x + hideBox.width <= pane.x + pane.width
      );
    })
    .toBe(true);
  await hide.click();
  await expect(project).toBeHidden();
});

test("Project options expose behavior, appearance, and sorting as submenus", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await page.setViewportSize({ width: 700, height: 500 });
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    (await import(/* @vite-ignore */ path)).setToolWindowSize("left", 185);
  });
  const header = page.locator('[data-toolwindow="project"] header');
  const options = header.getByRole("button", { name: "Options", exact: true });
  const locate = header.getByRole("button", { name: "Select Opened File", exact: true });
  await options.press("Enter");

  const menu = page.getByRole("menu", { name: "Project options", exact: true });
  const behavior = menu.getByRole("menuitem", { name: "Behavior", exact: true });
  const appearance = menu.getByRole("menuitem", { name: "Appearance", exact: true });
  const sort = menu.getByRole("menuitem", { name: "Sort By", exact: true });
  await expect(behavior).toBeVisible();
  await expect(behavior).toBeFocused();
  await behavior.press("ArrowRight");
  const alwaysSelect = page.getByRole("menuitemcheckbox", { name: "Always Select Opened File", exact: true });
  await expect(alwaysSelect).toBeFocused();
  await expect(alwaysSelect).toHaveAttribute("aria-checked", "false");
  await alwaysSelect.press("Enter");
  await expect(menu).toBeHidden();
  await expect(locate).toBeHidden();

  await options.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(appearance).toBeFocused();
  await appearance.press("ArrowRight");
  const rootPaths = page.getByRole("menuitemcheckbox", { name: "Show Root Paths", exact: true });
  await expect(rootPaths).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("ArrowLeft");
  await expect(rootPaths).toBeHidden();
  await expect(appearance).toBeFocused();

  await sort.click();
  const type = page.getByRole("menuitemcheckbox", { name: "Type", exact: true });
  await expect(type).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("menuitemcheckbox", { name: "Sort Folders First", exact: true })).toBeVisible();
  await type.click();
  await options.press("Enter");
  await sort.click();
  await expect(type).toHaveAttribute("aria-checked", "true");
});
