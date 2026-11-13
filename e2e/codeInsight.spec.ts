/**
 * Code intelligence through the editor: completion, navigation, usages, rename, quick fixes and
 * diagnostics. The language server is stubbed at the IPC layer; the servers themselves are covered
 * by `crates/ide-lsp/tests`.
 */
import type { Locator, Page } from "@playwright/test";
import type { CompletionItem } from "../src/bindings";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/build.gradle.kts`;

const at = (line: number, col: number) => ({ line, col });
const range = (line: number, from: number, to: number) => ({ start: at(line, from), end: at(line, to) });

/** Puts the caret just before `word` on the line containing `text`. */
async function caretAt(editor: Locator, page: Page, text: string, word: string) {
  const line = editor.locator(".cm-line", { hasText: text });
  await line.click();
  await page.keyboard.press("Home");
  const content = (await line.textContent()) ?? "";
  const indent = content.length - content.trimStart().length;
  for (let i = indent; i < content.indexOf(word); i++) await page.keyboard.press("ArrowRight");
}

async function openSample(page: Page) {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  return editor;
}

test("completion lists the server's items and inserts the chosen one", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(() => {
    const item = (label: string, kind: string, detail: string, insertText: string) => ({
      label,
      labelDetail: kind === "property" ? ` ${detail}` : "()",
      detail,
      kind,
      documentation: null,
      sortText: null,
      filterText: null,
      preselect: false,
      deprecated: false,
      insertText,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: "kotlin",
    });
    window.__ipc.handlers.lsp_completion = () => ({
      isIncomplete: false,
      items: [item("toDto", "method", "OrderDto", "toDto()"), item("total", "property", "BigDecimal", "total")],
    });
  });
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("order.");
  await page.keyboard.press("Control+Space");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.getByText("total", { exact: true })).toBeVisible();
  await expect(popup.getByText("toDto", { exact: true })).toBeVisible();
  const field = popup.locator("li").filter({ has: page.locator(".cm-completionLabel", { hasText: /^total$/ }) });
  await expect(field.locator(".cm-completionDetail")).toHaveCount(0);
  await expect(field.locator(".cm-lsp-type")).toHaveText("BigDecimal");
  const method = popup.locator("li").filter({ has: page.locator(".cm-completionLabel", { hasText: /^toDto$/ }) });
  await expect(method.locator(".cm-completionDetail")).toHaveText("()");
  await expect(method.locator(".cm-lsp-type")).toHaveText("OrderDto");
  await page.keyboard.type("toD");
  await expect(popup.getByText("total", { exact: true })).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toHaveText(/^\s*order\.toDto\(\)$/);
  expect((await ipcCalls(page, "lsp_completion")).length).toBeGreaterThan(0);
});

for (const key of ["Enter", "Tab"]) {
  for (const prefix of ["", "v"]) {
    test(`${key} leaves the caret after a field snippet at root.${prefix}`, async ({ workbench: page }, info) => {
      const editor = await openSample(page);
      await page.evaluate(() => {
        const item = (label: string): CompletionItem => ({
          label,
          labelDetail: null,
          labelDescription: "int",
          detail: "int",
          kind: "field",
          documentation: null,
          sortText: null,
          filterText: null,
          preselect: label === "val",
          deprecated: false,
          insertText: label,
          isSnippet: true,
          replaceRange: null,
          replaceRangeTab: null,
          additionalEdits: [],
          commitCharacters: [],
          command: null,
          data: null,
          server: 1,
        });
        window.__ipc.handlers.lsp_completion = () => ({ isIncomplete: false, items: [item("val"), item("value")] });
      });
      await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(`int a = root.${prefix}`);
      await page.keyboard.press("Control+Space");
      const popup = page.locator(".cm-tooltip-autocomplete");
      await expect(popup.getByText("val", { exact: true })).toBeVisible();
      // CodeMirror ignores acceptance during its 75 ms lookup interaction delay.
      await page.waitForTimeout(100);
      await page.keyboard.press(key);
      await expect(popup).toBeHidden();
      await page.screenshot({ path: info.outputPath("accepted-completion.png"), animations: "disabled" });
      await page.keyboard.type(";");
      await expect(editor.locator(".cm-activeLine")).toHaveText(/^\s*int a = root\.val;$/);
    });
  }
}

test("⌘B goes to the declaration in another file", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ path, target }) => {
      window.__ipc.handlers.lsp_goto = () => [{ path, range: target }];
    },
    { path: `${ROOT}/settings.gradle.kts`, target: range(20, 12, 17) },
  );
  await caretAt(editor, page, "val order: Order", "service");
  await page.keyboard.press("Meta+b");
  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(tabs.getByRole("tab", { name: "settings.gradle.kts" })).toHaveAttribute("aria-selected", "true");
  const target = page.locator(".cm-editor").filter({ has: page.locator(".cm-activeLine") });
  await expect(target.locator(".cm-activeLine")).toContainText("val order: Order = service.create(req)");
  const [args] = await ipcCalls(page, "lsp_goto");
  expect(args).toMatchObject({ pos: at(20, 27), kind: "definition" });
});

test("Find Usages lists every usage by file and opens one", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, other }) => {
      const loc = (path: string, line: number, from: number, to: number) => ({
        path,
        range: { start: { line, col: from }, end: { line, col: to } },
      });
      window.__ipc.handlers.lsp_references = () => ({
        locations: [loc(file, 16, 8, 15), loc(file, 20, 27, 34), loc(other, 16, 8, 15)],
        incomplete: null,
      });
    },
    { file: FILE, other: `${ROOT}/settings.gradle.kts` },
  );
  await caretAt(editor, page, "val order: Order", "service");
  await page.keyboard.press("Alt+F7");
  const usages = page.getByRole("tree", { name: /usages/i });
  await expect(usages.getByRole("treeitem", { name: "Found usages 3 results" })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: "build.gradle.kts 2 usages" })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: /^17 service\.find\(status/ })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: /^21 val order: Order = service\.create/ })).toBeVisible();
  const other = usages.getByRole("treeitem", { name: "settings.gradle.kts 1 usage" });
  await expect(other).toBeVisible();
  // Double-clicking a usage in another file opens that file.
  await usages.getByRole("treeitem", { name: /^17/ }).last().dblclick();
  await expect(
    page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "settings.gradle.kts" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("⇧F6 renames in place and sends the server's edit to be applied", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, prepared, uses }) => {
      window.__ipc.handlers.lsp_prepare_rename = () => prepared;
      window.__ipc.handlers.lsp_rename = (args) => ({
        edit: {
          files: [
            {
              kind: "edit",
              path: file,
              edits: uses.map((range) => ({ range, new_text: args.newName })),
            },
          ],
        },
        incomplete: null,
      });
    },
    { file: FILE, prepared: range(20, 12, 17), uses: [range(20, 12, 17), range(21, 15, 20)] },
  );
  await caretAt(editor, page, "val order: Order", "order");
  await page.keyboard.press("Shift+F6");
  await expect(page.getByText(/Press ⇧F6 to show dialog/)).toBeVisible();
  // The name starts selected; occurrences follow as it's typed.
  await page.keyboard.type("placed");
  await expect(editor.locator(".cm-line", { hasText: "val placed: Order" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => ipcCalls(page, "apply_workspace_edit")).toHaveLength(1);
  const [rename] = await ipcCalls(page, "lsp_rename");
  expect(rename).toMatchObject({ pos: at(20, 12), newName: "placed" });
  const [apply] = await ipcCalls(page, "apply_workspace_edit");
  expect(JSON.stringify(apply)).toContain('"new_text":"placed"');
});

test("indexed single-file rename previews all anchors and applies only after confirmation", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, prepared, uses }) => {
      window.__ipc.handlers.lsp_prepare_rename = () => prepared;
      window.__ipc.handlers.lsp_rename = (args) => ({
        preview: true,
        edit: {
          files: [{ kind: "edit", path: file, edits: uses.map((range) => ({ range, new_text: args.newName })) }],
          preconditions: [{ path: file, hash: "indexed-snapshot" }],
        },
        incomplete: null,
      });
      window.__ipc.handlers.apply_workspace_edit = () => null;
    },
    { file: FILE, prepared: range(20, 12, 17), uses: [range(20, 12, 17), range(21, 15, 20)] },
  );
  for (const confirm of [false, true]) {
    await caretAt(editor, page, "val order: Order", "order");
    await page.keyboard.press("Shift+F6");
    await expect(page.getByText(/Press ⇧F6 to show dialog/)).toBeVisible();
    await page.keyboard.type("placed");
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog", { name: "Rename 'order' to 'placed'" });
    await expect(preview).toBeVisible();
    await expect(preview.getByText("2 occurrences in 1 file")).toBeVisible();
    expect(await ipcCalls(page, "apply_workspace_edit")).toHaveLength(0);
    await preview.getByRole("button", { name: confirm ? "Do Refactor" : "Cancel", exact: true }).click();
    await expect(preview).toBeHidden();
  }
  await expect.poll(() => ipcCalls(page, "apply_workspace_edit")).toHaveLength(1);
  const [apply] = await ipcCalls(page, "apply_workspace_edit");
  expect(apply.edit).toMatchObject({ preconditions: [{ path: FILE, hash: "indexed-snapshot" }] });
});

test("diagnostics underline the range and ⌥⏎ applies the preferred quick fix", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, bad }) => {
      window.__ipc.handlers.lsp_code_actions = () => [
        {
          title: "Import 'com.acme.orders.model.Order'",
          kind: "quickfix",
          isPreferred: true,
          disabledReason: null,
          edit: {
            files: [
              {
                kind: "edit",
                path: file,
                edits: [
                  {
                    range: { start: { line: 4, col: 0 }, end: { line: 4, col: 0 } },
                    new_text: "import com.acme.orders.model.Order\n",
                  },
                ],
              },
            ],
          },
          command: null,
          data: null,
          server: "kotlin",
        },
        {
          title: "Create class 'Order'",
          kind: "quickfix",
          isPreferred: false,
          disabledReason: null,
          edit: null,
          command: null,
          data: null,
          server: "kotlin",
        },
      ];
      window.__ipc.emit({
        type: "diagnostics",
        path: file,
        source: "kotlin",
        items: [
          { range: bad, severity: "error", message: "Unresolved reference: Order", source: "kotlin", code: null },
        ],
      });
    },
    { file: FILE, bad: range(20, 19, 24) },
  );
  const squiggle = editor.locator(".cm-lintRange-error");
  await expect(squiggle).toHaveText("Order");
  await caretAt(editor, page, "val order: Order", "Order ");
  await page.keyboard.press("Alt+Enter");
  const fix = page.getByRole("option", { name: /Import 'com\.acme\.orders\.model\.Order'/ });
  await expect(fix).toBeVisible();
  await expect(page.getByRole("option", { name: /Create class 'Order'/ })).toBeVisible();
  await fix.click();
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
  const [applied] = await ipcCalls(page, "lsp_execute_code_action");
  expect(applied).toMatchObject({ action: { title: "Import 'com.acme.orders.model.Order'" } });
});

test("lazy plugin actions resolve only when invoked, never for their intention preview", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(() => {
    const action = {
      title: "Choose translation file",
      kind: "quickfix",
      isPreferred: true,
      disabledReason: null,
      edit: null,
      command: null,
      data: { plugin: "test.interactive-actions", data: "pick", file: false },
      server: 0,
    };
    window.__ipc.handlers.lsp_code_actions = () => [action];
    window.__ipc.handlers.lsp_resolve_code_action = () => ({ ...action, data: null, edit: { files: [] } });
    window.__ipc.handlers.lsp_execute_code_action = () => [];
  });
  await editor.locator(".cm-line", { hasText: "val order: Order" }).click();
  await page.keyboard.press("Alt+Enter");
  const fix = page.getByRole("option", { name: "Choose translation file", exact: true });
  await expect(fix).toBeVisible();
  await fix.hover();
  await expect(page.getByText("Preview isn't available for this action", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "lsp_resolve_code_action")).toHaveLength(0);
  expect(await ipcCalls(page, "lsp_execute_code_action")).toHaveLength(0);
  await fix.click();
  await expect.poll(() => ipcCalls(page, "lsp_resolve_code_action")).toHaveLength(1);
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
  const [applied] = await ipcCalls(page, "lsp_execute_code_action");
  expect(applied).toMatchObject({ action: { title: "Choose translation file", edit: { files: [] } } });
});
