import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const FILE = "/dev/acme-api/command-line.txt";

async function openEditor(page: Page) {
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toHaveAttribute("data-openidea-vim", "true");
  await editor.locator(".cm-content").click();
  return editor;
}

/** Computed type of one element: `null` when it is not in the DOM. */
function fontOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      ligatures: style.fontVariantLigatures,
    };
  }, selector);
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() =>
    localStorage.setItem("openidea.vim.v1", JSON.stringify({ enabled: true, handlers: {} })),
  );
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await stubDesktop(page);
  await page.evaluate(async (path) => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    docBackend().files.set(path, "alpha\nbravo\ncharlie\n");
    await editorService().openFile(path);
  }, FILE);
  await openEditor(page);
});

test("the command line renders in the editor's font", async ({ page }) => {
  await page.keyboard.press(":");
  await expect(page.locator(".cm-vim-panel input")).toBeVisible();
  await page.keyboard.type("echo hello");

  const prompt = await fontOf(page, ".cm-vim-panel input");
  // The package puts the prefix in a span with an inline `font-family: monospace`.
  const prefix = await fontOf(page, ".cm-vim-panel span");
  const body = await fontOf(page, ".cm-scroller");

  expect(prompt).not.toBeNull();
  expect(prefix).not.toBeNull();
  expect(body).not.toBeNull();
  expect(prompt!.family).toBe(body!.family);
  expect(prompt!.size).toBe(body!.size);
  expect(prefix!.family).toBe(prompt!.family);
  expect(prefix!.size).toBe(prompt!.size);
  // The browser's generic monospace (Consolas under WebView2) is what we are moving away from.
  expect(prompt!.family).not.toBe("monospace");
  expect(prompt!.ligatures).toBe("none");

  await page.keyboard.press("Escape");
});

test("the search prompt shares the command line's font", async ({ page }) => {
  await page.keyboard.press("/");
  await expect(page.locator(".cm-vim-panel input")).toBeVisible();
  await page.keyboard.type("alpha");

  const prompt = await fontOf(page, ".cm-vim-panel input");
  const body = await fontOf(page, ".cm-scroller");
  expect(prompt).not.toBeNull();
  expect(body).not.toBeNull();
  expect(prompt!.family).toBe(body!.family);
  expect(prompt!.size).toBe(body!.size);

  await page.keyboard.press("Escape");
});

test("the command line follows the editor's font variables", async ({ page }) => {
  // What Editor › Font and the zoom field write on the editor root.
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    editor.style.setProperty("--openidea-editor-font", '"Sentinel Mono"');
    editor.style.setProperty("--openidea-editor-font-size", "21px");
  });

  await page.keyboard.press(":");
  await expect(page.locator(".cm-vim-panel input")).toBeVisible();
  await page.keyboard.type("echo");

  const prompt = await fontOf(page, ".cm-vim-panel input");
  const body = await fontOf(page, ".cm-scroller");
  expect(prompt).not.toBeNull();
  expect(body).not.toBeNull();
  expect(prompt!.family).toContain("Sentinel Mono");
  expect(prompt!.size).toBe("21px");
  expect(prompt!.family).toBe(body!.family);
  expect(prompt!.size).toBe(body!.size);

  await page.keyboard.press("Escape");
});
