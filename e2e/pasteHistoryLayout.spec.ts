import { expect, openFromTree, test } from "./fixtures";

test("Paste from History keeps the list and preview usable in a short dialog", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  await content.focus();
  const baseFont = Number.parseFloat(await content.evaluate((el) => getComputedStyle(el).fontSize));
  await page.evaluate(async () => {
    const source = await (await fetch("/src/editor/core/extras.ts")).text();
    const imports = [...source.matchAll(/["'](\/src\/[^"']+)["']/g)].map((match) => match[1]!);
    const activePath = (path: string) => imports.find((url) => url.split("?")[0] === path) ?? path;
    const historyPath = activePath("/src/editor/core/clipboardHistory.ts");
    const actionsPath = activePath("/src/platform/actions.ts");
    const { recordClipboard } = await import(/* @vite-ignore */ historyPath);
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    recordClipboard("const older = 2;");
    recordClipboard("const newest = 1;\n// paste marker");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
    for (let i = 0; i < 5; i++) await executeAction("editor.increaseFontSize");
  });
  const fontSize = `${baseFont + 5}px`;
  await expect(content).toHaveCSS("font-size", fontSize);
  await page.keyboard.press("Meta+Shift+v");

  const dialog = page.getByRole("dialog", { name: "Choose Content to Paste" });
  const divider = dialog.getByRole("separator", { name: "Resize paste preview" });
  const list = dialog.getByRole("listbox", { name: "Clipboard history" });
  const preview = dialog.getByLabel("Paste preview", { exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(list.getByText("const newest = 1;", { exact: true })).toHaveCSS("font-size", fontSize);
  await expect(preview).toHaveCSS("font-size", fontSize);
  await expect(dialog.locator(".cm-gutters")).toHaveCount(0);

  await page.setViewportSize({ width: 420, height: 440 });
  const search = dialog.getByRole("textbox", { name: "Filter clipboard history" });
  const remove = dialog.getByRole("button", { name: "Delete" });
  await expect(search).toBeInViewport({ ratio: 1 });
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect((await remove.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
  const previous = Number(await divider.getAttribute("aria-valuenow"));
  await divider.press("ArrowDown");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(previous);
  const resized = await divider.getAttribute("aria-valuenow");
  await expect(dialog.getByRole("button", { name: "Paste" })).toBeInViewport({ ratio: 1 });
  await expect(preview).toContainText("// paste marker");

  await search.fill("older");
  await remove.click();
  await expect(dialog.getByText("No matches", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(search).toHaveValue("");
  await search.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(content).toContainText("const newest = 1;");

  await page.keyboard.press("Meta+Shift+v");
  await expect(divider).toHaveAttribute("aria-valuenow", resized!);
  await page.keyboard.press("Escape");
});
