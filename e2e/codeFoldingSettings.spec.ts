import { expect, openFromTree, test } from "./fixtures";

test("code folding controls stay grouped in narrow settings", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Code Folding");
  await dialog.getByRole("treeitem", { name: "Code Folding", exact: true }).click();

  const label = "Show code folding outline";
  const outline = dialog.getByRole("checkbox", { name: label, exact: true });
  const visibility = dialog.getByRole("button", { name: label, exact: true });
  const defaults = dialog.getByRole("region", { name: "Fold by default:", exact: true });
  await expect(visibility).toHaveText("On hover");
  const wideOutline = (await outline.boundingBox())!;
  expect((await visibility.boundingBox())!.x).toBeGreaterThan(wideOutline.x + wideOutline.width);

  await page.setViewportSize({ width: 520, height: 760 });
  await expect(visibility).toBeInViewport({ ratio: 0.98 });
  const rows = await Promise.all(
    ["File header", "Imports", "Documentation comments"].map((name) =>
      defaults.getByRole("checkbox", { name, exact: true }).boundingBox(),
    ),
  );
  expect(rows[0]!.x).toBe(rows[2]!.x);
  expect(rows[0]!.y).toBeLessThan(rows[1]!.y);
  expect(rows[1]!.y).toBeLessThan(rows[2]!.y);

  await outline.uncheck();
  await expect(dialog.getByRole("textbox", { name: label, exact: true })).toBeDisabled();
  await expect(defaults.getByRole("checkbox", { name: "Imports", exact: true })).toBeEnabled();
});

test("folding visibility applies to an already open editor and keeps folded arrows visible", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("export function sum() {\n  return 1 + 2;\n}\n");
  const arrow = editor.locator(".cm-foldGutter .cm-openidea-foldOpen").first();
  await expect(arrow).toHaveCSS("opacity", "0");

  const openSettings = async () => {
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Code Folding");
    await dialog.getByRole("treeitem", { name: "Code Folding", exact: true }).click();
    return dialog;
  };
  const label = "Show code folding outline";
  const settings = await openSettings();
  await settings.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("option", { name: "Always", exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await content.hover();
  await expect(arrow).toHaveCSS("opacity", "1");

  const reopened = await openSettings();
  const control = reopened.getByRole("button", { name: label, exact: true });
  await expect(control).toHaveText("Always");
  await control.click();
  await page.getByRole("option", { name: "On hover", exact: true }).click();
  await reopened.getByRole("button", { name: "OK", exact: true }).click();
  await content.hover();
  await expect(arrow).toHaveCSS("opacity", "0");
  await arrow.click();
  await content.hover();
  await expect(editor.locator(".cm-foldGutter .cm-openidea-foldClosed").first()).toHaveCSS("opacity", "1");
  await expect(editor.locator(".cm-foldPlaceholder").first()).toBeVisible();
});
