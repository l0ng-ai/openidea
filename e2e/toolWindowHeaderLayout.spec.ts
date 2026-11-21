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
