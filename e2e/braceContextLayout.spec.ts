import type { EditorView } from "@codemirror/view";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const declaration = "export function summarizeLedger(entries: number[])";
const source = [
  declaration,
  "{",
  "  let total = 0;",
  ...Array.from({ length: 80 }, (_, i) => `  total += entries[${i}] ?? 0;`),
  "  return total;",
  "}",
  "",
].join("\n");

async function openScope(page: Page, stickyScroll: boolean) {
  await page.evaluate(
    async ({ source, stickyScroll }) => {
      const backendPath = "/src/editor/core/backend.ts";
      const servicesPath = "/src/workbench/contributions.ts";
      const projectPath = "/src/platform/project.ts";
      const { docBackend } = await import(/* @vite-ignore */ backendPath);
      const { editorService } = await import(/* @vite-ignore */ servicesPath);
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, stickyScroll, fontSize: 17 } } });
      const path = "/dev/acme-api/ledger.ts";
      docBackend().files.set(path, source);
      await editorService().openFile(path);
    },
    { source: stickyScroll ? source.replace(declaration + "\n{", declaration + " {") : source, stickyScroll },
  );
  const editor = page.locator('.cm-editor[data-language="TypeScript"]');
  await expect(editor.locator(".cm-content")).toBeVisible();
  return editor;
}

async function focusClosingBrace(editor: Locator) {
  await editor.locator(".cm-content").evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    const close = view.state.doc.line(view.state.doc.lines - 1).to;
    view.focus();
    view.dispatch({ selection: { anchor: close }, scrollIntoView: true });
  });
  await expect(editor.locator(".cm-matchingBracket").filter({ hasText: "}" })).toBeInViewport();
}

test("the opening scope context appears above a distant matching brace", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 720, height: 630 });
  const editor = await openScope(page, false);
  await focusClosingBrace(editor);
  const scroller = editor.locator(".cm-scroller");
  const scrollTop = await scroller.evaluate((node) => node.scrollTop);
  const context = editor.getByRole("tooltip", { name: "Matching scope" });
  await expect(context).toBeVisible();
  await expect(context).toBeInViewport({ ratio: 1 });
  await expect(context).toContainText(declaration);
  await expect(context).toHaveCSS("font-size", "17px");
  expect((await context.boundingBox())!.y).toBeCloseTo((await scroller.boundingBox())!.y, 0);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  await expect(editor.locator(".cm-content")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(context).toBeHidden();
});

test("a pinned opening line suppresses the matching scope context", async ({ workbench: page }) => {
  const editor = await openScope(page, true);
  await focusClosingBrace(editor);
  await expect(editor.locator('.cm-openidea-stickyLine[data-line="1"]')).toContainText(declaration);
  await expect(editor.locator('.cm-openidea-stickyLine[data-line="1"]')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(editor.getByRole("tooltip", { name: "Matching scope" })).toBeHidden();
});
