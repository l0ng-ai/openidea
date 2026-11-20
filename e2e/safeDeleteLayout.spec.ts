import type { EditorView } from "@codemirror/view";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("Safe Delete lays out the search option and makes View Usages the default in a narrow window", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "App.tsx");
  await page.setViewportSize({ width: 425, height: 500 });
  const content = editor.locator(".cm-content");
  const symbol = "reconcileOutstandingSupplierAdjustmentsForTheMonthlySettlementArchive";
  const source = [
    `export function ${symbol}() {`,
    "  return 1;",
    "}",
    "",
    `const debit = ${symbol}();`,
    `const credit = ${symbol}();`,
  ].join("\n");
  await content.evaluate(
    (element, { source, symbol }) => {
      const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        selection: { anchor: source.indexOf(symbol) + 1 },
      });
      view.focus();
    },
    { source, symbol },
  );
  await stubDesktop(page);
  await page.evaluate(
    ({ source, symbol }) => {
      const path = "/dev/acme-api/App.tsx";
      const range = (line: number, col: number, end = col + symbol.length) => ({
        start: { line, col },
        end: { line, col: end },
      });
      const selection = range(0, "export function ".length);
      const handlers = window.__ipc.handlers;
      handlers.lsp_goto = () => [{ path, range: selection }];
      handlers.doc_outline = () => [
        {
          name: symbol,
          detail: null,
          kind: "function",
          range: { start: { line: 0, col: 0 }, end: { line: 2, col: 1 } },
          selection_range: selection,
          children: [],
        },
      ];
      handlers.languages = () => [];
      handlers.lsp_references = () => ({
        locations: [
          { path, range: range(4, "const debit = ".length) },
          { path, range: range(5, "const credit = ".length) },
        ],
        incomplete: null,
      });
      handlers.fs_read_text = () => source;
    },
    { source, symbol },
  );
  const openSafeDelete = () =>
    page.evaluate(async () => {
      const module = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ module);
      void executeAction("refactor.safeDelete");
    });
  const usageSearches = async () => (await ipcCalls(page, "lsp_references")).filter((call) => call.projectWide);

  await openSafeDelete();
  const prompt = page.getByRole("dialog", { name: "Safe Delete", exact: true });
  await expect(prompt.locator("[data-dialog-titlebar]")).toHaveText("Safe Delete");
  const description = prompt.getByText(`Delete Function '${symbol}'?`);
  const commentSearch = prompt.getByRole("checkbox", { name: "Search in comments and strings" });
  await expect(commentSearch).toBeChecked();
  const expectedLeft = (await description.boundingBox())!.x;
  expect((await commentSearch.boundingBox())!.x).toBeCloseTo(expectedLeft, 0);
  await expect(prompt.locator("[data-dialog-body]")).toContainText(symbol);
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(content).toBeFocused();
  expect(await usageSearches()).toHaveLength(0);

  await openSafeDelete();
  await commentSearch.uncheck();
  await prompt.getByRole("button", { name: "OK", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "Usages Detected", exact: true });
  await expect(conflict.getByRole("heading", { name: "2 usages found" })).toBeVisible();
  await expect(conflict.getByText(`Function '${symbol}' has 2 usages that are not safe to delete.`)).toBeVisible();
  for (const button of ["View Usages", "Delete Anyway", "Cancel"]) {
    await expect(conflict.getByRole("button", { name: button, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(
    await conflict.locator("[data-dialog-body]").evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBe(0);
  await expect(conflict.getByRole("button", { name: "View Usages" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(conflict).toBeHidden();
  await expect(page.getByRole("region", { name: "Find Usages", exact: true })).toBeVisible();
  await expect(content).toContainText("export function");
  expect(await usageSearches()).toHaveLength(1);
});
