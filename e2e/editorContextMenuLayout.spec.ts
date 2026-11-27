import { expect, test } from "./fixtures";

const source =
  "export function summarizeOrders(items: number[]): number {\n  const sharedToken = items.reduce((sum, value) => sum + value, 0);\n  return sharedToken;\n}\n";
const file = "/dev/acme-api/summary.ts";

test("the editor context menu groups editing, selection search and opening actions", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 650, height: 480 });
  await page.evaluate(
    async ({ file, source }) => {
      const backend = "/src/editor/core/backend.ts";
      const contributions = "/src/workbench/contributions.ts";
      const platform = "/src/platform/platformInfo.ts";
      const { docBackend } = await import(/* @vite-ignore */ backend);
      const { editorService } = await import(/* @vite-ignore */ contributions);
      const { usePlatform } = await import(/* @vite-ignore */ platform);
      usePlatform.setState({ os: "windows" });
      docBackend().files.set(file, source);
      await editorService().openFile(file);
    },
    { file, source },
  );
  await expect(page.locator(".cm-content")).toContainText("sharedToken");
  const points = await page.evaluate(async (source) => {
    const editorApi = "/src/editor/api.ts";
    const { activeEditor } = await import(/* @vite-ignore */ editorApi);
    const { view } = activeEditor();
    const from = source.indexOf("sharedToken");
    view.dispatch({ selection: { anchor: from, head: from + "sharedToken".length } });
    view.focus();
    const coords = (offset: number) => {
      const rect = view.coordsAtPos(offset)!;
      return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
    };
    return { selection: coords(from + 2), outside: coords(source.indexOf("return") + 2) };
  }, source);
  const openMenuAt = async (point: { x: number; y: number }) => {
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(page.getByRole("menu", { name: "Context menu" })).toBeVisible();
  };
  await openMenuAt(points.selection);
  const menu = page.getByRole("menu", { name: "Context menu" });
  const groups = await menu
    .locator('[role="separator"], [role="menuitem"], [role="menuitemcheckbox"]')
    .evaluateAll((elements) => {
      const groups: string[][] = [[]];
      for (const element of elements) {
        if (element.getAttribute("role") === "separator") groups.push([]);
        else groups.at(-1)!.push(element.querySelector('[class*="_label_"]')!.textContent!);
      }
      return groups;
    });
  expect(groups).toContainEqual(["Cut", "Copy", "Paste", "Copy / Paste Special", "Column Selection Mode"]);
  expect(groups).toContainEqual(["Find in Files…", "Find Usages", "Go To"]);
  expect(groups).toContainEqual(["Run 'summary.ts'", "Debug 'summary.ts'", "More Run/Debug"]);
  expect(groups).toContainEqual(["Split Right", "Open In"]);
  expect(groups).toContainEqual(["Local History", "Git"]);

  for (const shortcut of ["Ctrl+X", "Ctrl+C", "Ctrl+V"]) {
    await expect(menu.getByText(shortcut, { exact: true })).toBeVisible();
  }
  await expect(menu.getByText("Paste", { exact: true })).toHaveCSS("font-size", "13px");
  await expect(menu.locator("xpath=ancestor::*[@data-popup][1]")).toBeInViewport({ ratio: 1 });

  await menu.getByRole("menuitem", { name: /^Find in Files/ }).click();
  const find = page.getByRole("dialog", { name: "Find in Files" });
  await expect(find.getByRole("textbox", { name: "Text to find" })).toHaveValue("sharedToken");
  await page.keyboard.press("Escape");
  await expect(find).toHaveCount(0);

  await openMenuAt(points.outside);
  await expect(menu.getByRole("menuitem", { name: /^Find in Files/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /^Cut\b/ })).toHaveCount(0);
  const split = menu.getByRole("menuitem", { name: /^Split Right/ });
  await split.click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveCount(2);
});
