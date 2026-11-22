import { expect, openFromTree, stubDesktop, test } from "./fixtures";

test("the docked Structure tree starts under the header and keeps its commands available", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const range = { start: { line: 0, col: 0 }, end: { line: 1, col: 1 } };
    const field = {
      name: "orderCount",
      kind: "field",
      visibility: "private",
      range,
      selection_range: range,
      children: [],
    };
    window.__ipc.handlers.doc_outline = () => [
      { name: "OrderController", kind: "class", range, selection_range: range, children: [field] },
    ];
    window.__ipc.handlers.lsp_type_hierarchy = () => [];
    const path = "/src/workbench/toolwindows/store.ts";
    const { moveToolWindow, setToolWindowSize, showToolWindow } = await import(/* @vite-ignore */ path);
    moveToolWindow("structure", "right");
    setToolWindowSize("right", 240);
    showToolWindow("structure", true);
  });
  const panel = page.getByRole("region", { name: "Structure", exact: true });
  const header = panel.locator("header").first();
  const tree = panel.getByRole("tree", { name: "Structure" });
  const field = tree.getByRole("treeitem", { name: "orderCount" });
  await expect(field).toBeVisible();
  await expect
    .poll(async () => {
      const h = (await header.boundingBox())!;
      const t = (await tree.boundingBox())!;
      return t.y - h.y - h.height;
    })
    .toBeLessThan(2);

  const viewOptions = header.getByRole("button", { name: "View Options", exact: true });
  await viewOptions.click();
  const viewMenu = page.getByRole("menu", { name: "View Options", exact: true });
  await expect(viewMenu.getByRole("menuitemcheckbox", { name: "Sort Alphabetically" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitemcheckbox", { name: "Show Inherited" })).toBeVisible();
  await viewMenu.getByRole("menuitemcheckbox", { name: "Show Fields", checked: true }).click();
  await expect(field).toBeHidden();
  await viewOptions.click();
  await viewMenu.getByRole("menuitemcheckbox", { name: "Show Fields", checked: false }).click();
  await expect(field).toBeVisible();

  const more = header.getByRole("button", { name: "Options", exact: true });
  const menu = page.getByRole("menu", { name: "Structure options" });
  await more.click();
  await menu.getByRole("menuitem", { name: "Collapse All", exact: true }).click();
  await expect(field).toBeHidden();
  await more.click();
  await menu.getByRole("menuitem", { name: "Expand All", exact: true }).click();
  await expect(field).toBeVisible();
  await more.click();
  await menu.getByRole("menuitemcheckbox", { name: "Autoscroll from Source", checked: false }).click();
  await more.click();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Autoscroll from Source", checked: true })).toBeVisible();
});

test("File Structure keeps symbol filters readable at desktop and minimum window widths", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const range = { start: { line: 0, col: 0 }, end: { line: 1, col: 1 } };
    const field = {
      name: "orderCount",
      kind: "field",
      visibility: "private",
      range,
      selection_range: range,
      children: [],
    };
    const methods = Array.from({ length: 36 }, (_, i) => ({
      name: `method${String(i).padStart(2, "0")}`,
      kind: "method",
      range,
      selection_range: range,
      children: [],
    })).reverse();
    window.__ipc.handlers.doc_outline = () => [
      { name: "OrderController", kind: "class", range, selection_range: range, children: [field, ...methods] },
    ];
    window.__ipc.handlers.lsp_type_hierarchy = () => [];
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction("navigate.fileStructure");
  });

  const dialog = page.getByRole("dialog", { name: "File Structure" });
  const filter = dialog.getByRole("textbox", { name: "Filter symbols" });
  const options = dialog.getByRole("button", { name: "View Options" });
  const tree = dialog.getByRole("tree", { name: "Symbols" });
  const fields = dialog.getByRole("checkbox", { name: "Show fields" });
  await expect(dialog.getByRole("checkbox", { name: "Show inherited members" })).toBeVisible();
  await expect(filter).toBeFocused();
  await expect(options).toBeVisible();
  for (const width of [400, 1000]) {
    await page.setViewportSize({ width, height: 420 });
    const clipped = await dialog.evaluate((element) => {
      const labels = [...element.querySelectorAll("label")].filter((label) =>
        label.querySelector('input[type="checkbox"]'),
      );
      const row = labels[0]!.parentElement!.getBoundingClientRect();
      return labels.flatMap((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        const box = range.getBoundingClientRect();
        return box.top < row.top - 1 || box.right > row.right + 1 || box.bottom > row.bottom + 1
          ? [label.textContent]
          : [];
      });
    });
    expect(clipped).toEqual([]);
    await expect(options).toBeInViewport({ ratio: 1 });
    const filterTop = (await filter.boundingBox())!.y;
    expect((await options.boundingBox())!.y).toBeLessThan(filterTop);
    expect((await tree.boundingBox())!.y).toBeGreaterThan(filterTop);
  }
  // The dialog scales in when it opens: wait for its settled width.
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(540);
  const field = dialog.getByRole("treeitem", { name: "orderCount" });
  await expect(field).toBeVisible();
  await fields.uncheck();
  await expect(field).toBeHidden();

  await tree.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(tree.getByRole("treeitem", { name: "method00", exact: true })).toBeInViewport();
  await expect(options).toBeInViewport({ ratio: 1 });
  await expect(filter).toBeInViewport({ ratio: 1 });

  await options.click();
  const menu = page.getByRole("menu", { name: "View Options" });
  await expect(menu).toBeInViewport({ ratio: 1 });
  const alphabetically = menu.getByRole("menuitemcheckbox", { name: "Sort Alphabetically" });
  await expect(alphabetically).not.toBeChecked();
  await alphabetically.click();
  await expect(menu).toBeHidden();
  await tree.evaluate((el) => (el.scrollTop = 0));
  await expect(tree.getByRole("treeitem").nth(1)).toHaveAccessibleName("method00");

  await filter.fill("method21");
  await expect(tree.getByRole("treeitem", { name: "method21", selected: true })).toBeVisible();
  await options.click();
  await menu.getByRole("menuitemcheckbox", { name: "Narrow down on typing", checked: true }).click();
  await expect(tree.getByRole("treeitem", { name: "method22", exact: true })).toBeVisible();
  await options.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(options).toBeFocused();
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
});
