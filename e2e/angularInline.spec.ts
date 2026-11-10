import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function placeCaret(page: Page, marker: string) {
  await page.locator(".cm-content").evaluate((element, marker) => {
    const view = (element as HTMLElement & { cmTile: { view: import("@codemirror/view").EditorView } }).cmTile.view;
    const anchor = view.state.doc.toString().indexOf(marker) + marker.length;
    view.dispatch({ selection: { anchor } });
    view.focus();
  }, marker);
}

test("Angular templates highlight and close tags in inline and external documents", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    const files = docBackend().files;
    files.set("/dev/acme-api/angular.json", "{}");
    files.set(
      "/dev/acme-api/app.ts",
      '@Component({\n  template: `<div [title]="name">{{ name }}</div>\n    @if (ready) { <p>Ready</p> }\n    <r-card\n    <section\n    <article><\n  `\n})\nexport class App {}\n',
    );
    files.set("/dev/acme-api/app.html", "<r-card\n<div\n<article><");
    files.set("/dev/acme-api/plain.ts", "const data = { template: `<r-card/>` };");
    await editorService().openFile("/dev/acme-api/app.ts");
  });
  const inline = page.locator('.cm-editor[data-language="Angular TypeScript"]');
  await expect(inline).toBeVisible();
  await expect(inline.locator(".cm-content span").filter({ hasText: /^div$/ }).first()).toBeVisible();
  await expect(inline.locator(".cm-content span").filter({ hasText: /^@if$/ })).toBeVisible();
  for (const [marker, text, result] of [
    ["<r-card", "/", "<r-card/>"],
    ["<section", ">", "<section></section>"],
    ["<article><", "/", "<article></article>"],
  ]) {
    await placeCaret(page, marker!);
    await page.keyboard.type(text!);
    await expect(inline.locator(".cm-content")).toContainText(result!);
  }
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    await (await import(path)).editorService().openFile("/dev/acme-api/app.html");
  });
  const external = page.locator('.cm-editor[data-language="Angular Template"]');
  await expect(external).toBeVisible();
  for (const [marker, text, result] of [
    ["<r-card", "/", "<r-card/>"],
    ["<div", ">", "<div></div>"],
    ["<article><", "/", "<article></article>"],
  ]) {
    await placeCaret(page, marker!);
    await page.keyboard.type(text!);
    await expect(external.locator(".cm-content")).toContainText(result!);
  }
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    await (await import(path)).editorService().openFile("/dev/acme-api/plain.ts");
  });
  await expect(page.locator(".cm-content span").filter({ hasText: /^r-card$/ })).toHaveCount(0);
});
