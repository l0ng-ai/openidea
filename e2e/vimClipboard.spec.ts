import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const FILE = "/dev/acme-api/probe.txt";

async function openEditor(page: Page) {
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toHaveAttribute("data-openidea-vim", "true");
  await editor.locator(".cm-content").click();
  return editor;
}

async function reset(page: Page, doc: string) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(async (text) => {
    // Load the app module in the browser's Vite realm; the variable keeps knip from resolving the URL.
    const apiPath = "/src/editor/api.ts";
    const { activeEditor } = await import(apiPath);
    const view = activeEditor()!.view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
    view.focus();
  }, doc);
}

async function keys(page: Page, ...strokes: string[]) {
  for (const stroke of strokes) await page.keyboard.press(stroke);
}

/** The app talks to the desktop backend for the clipboard; route those two commands to the browser's. */
async function bridgeClipboard(page: Page) {
  await page.evaluate(() => {
    window.__ipc.handlers["clipboard_write_text"] = async ({ text }) => {
      await navigator.clipboard.writeText(text as string);
      return null;
    };
    window.__ipc.handlers["clipboard_text"] = () => navigator.clipboard.readText();
  });
}

/** Windows stores text with CRLF; compare the text Vim would see. */
const readClipboard = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText().then((text) => text.replace(/\r\n/g, "\n")));

async function expectClipboard(page: Page, text: string) {
  await expect.poll(() => readClipboard(page)).toBe(text);
}

const documentText = (page: Page) =>
  page.evaluate(async () => {
    // Load the app module in the browser's Vite realm; the variable keeps knip from resolving the URL.
    const apiPath = "/src/editor/api.ts";
    const { activeEditor } = await import(apiPath);
    return activeEditor()!.view.state.doc.toString();
  });

test.beforeEach(async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() =>
    localStorage.setItem("openidea.vim.v1", JSON.stringify({ enabled: true, handlers: {} })),
  );
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await stubDesktop(page);
  await bridgeClipboard(page);
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

/** Applies rc file lines through the same parser and engine the app uses. */
async function applyRc(page: Page, rc: string) {
  await page.evaluate(async (text) => {
    // Load the app modules in the browser's Vite realm; the variables keep knip from resolving the URLs.
    const enginePath = "/src/features/vim/engine.ts";
    const rcPath = "/src/features/vim/rc.ts";
    const { applyRcCommands } = await import(enginePath);
    const { parseVimrc } = await import(rcPath);
    applyRcCommands(parseVimrc(text).commands);
  }, rc);
}

test("unnamed register writes stay out of the clipboard by default", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha\nbravo\n");
  await keys(page, "y", "y");
  await page.waitForTimeout(150);
  expect(await readClipboard(page)).toBe("SENTINEL");

  await keys(page, "d", "d");
  await page.waitForTimeout(150);
  expect(await readClipboard(page)).toBe("SENTINEL");
});

test("clipboard+=unnamed mirrors unnamed yanks and deletes", async ({ page }) => {
  await applyRc(page, "set clipboard+=unnamed");

  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha\nbravo\ncharlie\n");
  await keys(page, "y", "y");
  await expectClipboard(page, "alpha\n");

  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha\nbravo\ncharlie\n");
  await keys(page, "d", "d");
  await expectClipboard(page, "alpha\n");

  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha bravo\n");
  await keys(page, "v", "e", "y");
  await expectClipboard(page, "alpha");
});

test("explicit registers keep the clipboard out of the sync", async ({ page }) => {
  await applyRc(page, "set clipboard+=unnamed");

  for (const strokes of [
    ['"', "a", "y", "y"],
    ['"', "_", "d", "d"],
  ]) {
    await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
    await reset(page, "alpha\nbravo\n");
    await keys(page, ...strokes);
    await page.waitForTimeout(150);
    expect(await readClipboard(page)).toBe("SENTINEL");
  }

  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha\nbravo\n");
  await keys(page, '"', "+", "y", "y");
  await expectClipboard(page, "alpha\n");
});

test("the editor mirrors the current Vim mode", async ({ page }) => {
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toHaveAttribute("data-vim-mode", "normal");
  await keys(page, "i");
  await expect(editor).toHaveAttribute("data-vim-mode", "insert");
  await page.keyboard.press("Escape");
  await keys(page, "v");
  await expect(editor).toHaveAttribute("data-vim-mode", "visual");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveAttribute("data-vim-mode", "normal");
});

test("Insert mode pastes with Ctrl+V and Shift+Insert, staying in Insert mode", async ({ page }) => {
  const editor = page.locator(".cm-editor").first();
  for (const stroke of ["Control+V", "Shift+Insert"]) {
    await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
    await reset(page, "one\ntwo\n");
    await keys(page, "i");
    await page.keyboard.press(stroke);
    await expect.poll(() => documentText(page)).toBe("PASTEDone\ntwo\n");
    await expect(editor).toHaveAttribute("data-vim-mode", "insert");
    await page.keyboard.press("Escape");
  }
});

test("Visual mode Ctrl+C copies the selection and returns to Normal mode", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await reset(page, "alpha bravo\n");
  await keys(page, "v", "e");
  await page.keyboard.press("Control+C");
  await expectClipboard(page, "alpha");
  await expect(page.locator(".cm-editor").first()).toHaveAttribute("data-vim-mode", "normal");
  expect(await documentText(page)).toBe("alpha bravo\n");
});

test("the settings page documents what Ctrl+V and Ctrl+C do in each mode", async ({ page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings", exact: true }).fill("Vim");
  await settings.getByRole("treeitem", { name: "Vim", exact: true }).click();

  const conflicts = settings.getByRole("region", { name: "Shortcut conflicts", exact: true });
  await expect(
    conflicts.getByText(
      "Ctrl+V pastes in Insert mode and starts a Visual block in Normal and Visual modes. Ctrl+C copies the selection in Visual mode and otherwise leaves the current mode.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    settings.getByText(
      "Unnamed yanks and deletes stay in Vim's registers. Add set clipboard+=unnamed (or set clipboard=unnamedplus) to the rc file to mirror them to the system clipboard.",
      { exact: true },
    ),
  ).toBeVisible();
  const rowFor = (description: string, stroke: string) =>
    conflicts
      .getByRole("row", { name: new RegExp(description) })
      .getByRole("button", { name: `Handler for ${stroke}` });
  await expect(rowFor("Visual block; paste in Insert mode", "Ctrl+V")).toBeVisible();
  await expect(rowFor("Exit to Normal mode; copy a Visual selection", "Ctrl+C")).toBeVisible();
});

test("Visual mode Ctrl+C still leaves Visual mode when the clipboard cannot be written", async ({ page }) => {
  await reset(page, "alpha bravo\n");
  await keys(page, "v", "e");
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await page.keyboard.press("Control+C");
  await expect(page.locator(".cm-editor").first()).toHaveAttribute("data-vim-mode", "normal");
  expect(await documentText(page)).toBe("alpha bravo\n");
});

test("clipboard text pasted with +p keeps its line shape", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("hello\r\n"));
  await reset(page, "one\ntwo\n");
  await keys(page, '"', "+", "p");
  await expect.poll(() => documentText(page)).toBe("one\nhello\ntwo\n");

  await reset(page, "one\ntwo\n");
  await keys(page, '"', "+", "y", "y");
  await reset(page, "one\ntwo\n");
  await keys(page, '"', "+", "p");
  await expect.poll(() => documentText(page)).toBe("one\none\ntwo\n");
});
