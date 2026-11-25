import { expect, openFromTree, test } from "./fixtures";

const longName = "estimatedInvoiceTotal".repeat(6);

test("inline refactoring names use the editor font and keep the shortcut in a footer", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 600, height: 640 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { settings } = useProject.getState();
    useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, fontSize: 20 } } });
  });
  const content = editor.locator(".cm-content");
  await expect(content).toHaveCSS("font-size", "20px");
  await content.click();
  await page.evaluate(async (longName) => {
    const editorApi = "/src/editor/api.ts";
    const inplace = "/src/editor/lsp/inplaceRename.ts";
    const { activeEditor } = await import(/* @vite-ignore */ editorApi);
    const { startInplaceRename } = await import(/* @vite-ignore */ inplace);
    const { view } = activeEditor();
    const text = view.state.doc.toString();
    const from = text.indexOf("toDto");
    view.focus();
    startInplaceRename(view, {
      primary: { from, to: from + 5 },
      others: [],
      suggestions: ["toDto", "orderDto", "order", ...Array.from({ length: 8 }, (_, i) => `candidate${i}`), longName],
      hint: "Press ⇧F6 to show dialog with more options",
      commit: () => {},
      dialog: () => {},
    });
  }, longName);

  const names = page.getByRole("list", { name: "Suggested names" });
  await expect(names).toBeVisible();
  await expect(names).toHaveCSS("font-size", "20px");
  const shortcut = page.getByText("Press ⇧F6 to show dialog with more options", { exact: true });
  await expect(shortcut).toHaveCSS("font-size", "12px");
  const listBox = (await names.boundingBox())!;
  const editorBox = (await editor.boundingBox())!;
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(editorBox.x + editorBox.width);

  const primary = editor.locator(".cm-lsp-inplace-primary");
  const first = names.getByRole("button", { name: "toDto", exact: true });
  await expect(first).toHaveAttribute("aria-current", "true");
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(34);
  await page.keyboard.press("ArrowUp");
  const last = names.getByRole("button", { name: longName, exact: true });
  await expect(last).toHaveAttribute("aria-current", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("ArrowDown");
  await expect(first).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await expect(primary).toHaveText("orderDto");
  await expect(names.getByRole("button", { name: "orderDto", exact: true })).toHaveAttribute("aria-current", "true");
  await names.getByRole("button", { name: "order", exact: true }).click();
  await expect(primary).toHaveText("order");
  await expect(content).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(names).toHaveCount(0);
  await expect(content).toContainText("toDto");
});
