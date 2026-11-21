import { expect, openFromTree, test } from "./fixtures";

test("hover previews collapsed source at the editor font size", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  const source = [
    "export function formatOrder(total: number) {",
    '  const currency = "USD";',
    "  return currency + total.toFixed(2);",
    "}",
    "export const example = 42;",
  ].join("\n");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(source);
  await expect(editor.locator(".cm-line").first()).toHaveText(source.split("\n")[0]!);

  await editor.locator(".cm-foldGutter .cm-openidea-foldOpen").first().click();
  const placeholder = editor.locator(".cm-foldPlaceholder");
  await expect(placeholder).toBeVisible();
  const preview = page.getByRole("tooltip", { name: "Folded code" });
  await placeholder.hover();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('const currency = "USD";');
  await expect(preview).toContainText("return currency + total.toFixed(2);");
  await expect(preview).not.toContainText("export const example");
  await expect(preview).toHaveCSS("font-size", await content.evaluate((el) => getComputedStyle(el).fontSize));
  await expect(preview).toBeInViewport({ ratio: 1 });
  expect((await preview.boundingBox())!.y).toBeGreaterThan((await placeholder.boundingBox())!.y);
  expect(await preview.locator("code span").count()).toBeGreaterThan(0);

  await editor.getByText("formatOrder", { exact: true }).hover();
  await expect(preview).toBeHidden();
  await placeholder.hover();
  await expect(preview).toBeVisible();
  await placeholder.click();
  await expect(preview).toBeHidden();
  await expect(placeholder).toBeHidden();
  await expect(editor.getByText("currency", { exact: true }).first()).toBeVisible();
});

test("fold previews fit a narrow split and use its zoomed text size", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  const body = Array.from(
    { length: 40 },
    (_, i) => `  const row${i} = "A long line of source for checking the preview bounds";`,
  );
  await page.keyboard.insertText(["function run() {", ...body, "}"].join("\n"));
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ path)).executeAction("editor.splitRight");
  });
  await page.setViewportSize({ width: 680, height: 640 });
  const panes = page.locator("[data-pane-id]");
  await expect(panes).toHaveCount(2);
  const pane = panes.last();
  const right = pane.locator(".cm-content");
  const original = await right.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await right.press("Alt+Shift+.");
  await expect(right).toHaveCSS("font-size", `${original + 1}px`);
  await pane.locator(".cm-foldGutter .cm-openidea-foldOpen").first().click();
  await pane.locator(".cm-foldPlaceholder").hover();
  const preview = page.getByRole("tooltip", { name: "Folded code" });
  await expect(preview).toBeInViewport({ ratio: 1 });
  await expect(preview).toHaveCSS("font-size", `${original + 1}px`);
  await expect(preview.locator("code").first()).toContainText("const row0");
  const bounds = await preview.boundingBox();
  const paneBounds = await pane.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(Math.floor(paneBounds!.x));
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(Math.ceil(paneBounds!.x + paneBounds!.width));
  expect(await preview.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});
