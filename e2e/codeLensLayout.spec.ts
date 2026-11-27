import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

/** Opens the sample with the server's lenses `titles` above its first line, at editor font `fontSize`. */
async function lensRow(page: Page, fontSize: number, titles: string[]): Promise<{ editor: Locator; row: Locator }> {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ fontSize, titles }) => {
      const projectPath = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, fontSize } } });
      const at = { line: 0, col: 0 };
      window.__ipc.handlers.lsp_code_lens = () =>
        titles.map((title) => ({ range: { start: at, end: at }, command: { title, command: "noop", arguments: [] } }));
    },
    { fontSize, titles },
  );
  // An edit asks the server for its lenses again.
  await editor.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  const row = editor.locator(".cm-openidea-lens");
  await expect(row).toContainText(titles[0]!);
  return { editor, row };
}

test("a Code Vision row fits CJK hints at a large editor font", async ({ workbench: page }) => {
  const { editor, row } = await lensRow(page, 20, ["10 个用法", "无用法"]);
  const overflow = await row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll(".cm-openidea-lensItem")].map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      const text = range.getBoundingClientRect();
      return Math.max(box.top - text.top, text.bottom - box.bottom);
    });
  });
  expect(overflow).toHaveLength(2);
  for (const px of overflow) expect(px).toBeLessThanOrEqual(0);
  // The editor measured the taller row: the lines below it still sit beside their numbers.
  const line = editor.locator(".cm-line", { hasText: "class OrderController" });
  const number = editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^8$/ });
  const [lineTop, numberTop] = [(await line.boundingBox())!.y, (await number.boundingBox())!.y];
  expect(Math.abs(lineTop - numberTop)).toBeLessThanOrEqual(1);
});

test("a Code Vision row keeps its height at the default editor font", async ({ workbench: page }) => {
  const { row } = await lensRow(page, 13, ["3 usages"]);
  expect((await row.boundingBox())!.height).toBe(16);
});
