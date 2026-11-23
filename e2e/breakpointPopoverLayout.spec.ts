import type { EditorView } from "@codemirror/view";
import { expect, stubDesktop, test } from "./fixtures";

test("gutter breakpoint keeps its location and buttons visible while editing in a short window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 410, height: 340 });
  await stubDesktop(page);
  const name = "RecalculateInternationalPaymentsAcrossMultipleRegionalSettlementCyclesAndVerifyReceiptTotals.ts";
  const path = `/dev/acme-api/${name}`;
  await page.evaluate(async (path) => {
    const contributionsModule = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ contributionsModule);
    await editorService().openFile(path);
  }, path);
  await page.locator(".cm-content").evaluate(async (editor, path) => {
    const view = (editor as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    const insert = Array.from({ length: 14 }, (_, i) => `const amount${i + 1} = ${i * 10};`).join("\n");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
    const breakpointsModule = "/src/features/debugger/breakpoints/store.ts";
    const { addBreakpoint } = await import(/* @vite-ignore */ breakpointsModule);
    window.__ipc.handlers.debug_set_breakpoints = () => [];
    addBreakpoint(path, 7, { condition: "amount8 > 50", hitCondition: ">= 3", logMessage: "amount: {amount8}" });
  }, path);
  const marker = page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^8$/ });
  const open = () => marker.click({ button: "right" });
  await open();

  const popup = page.getByRole("dialog", { name: "Breakpoint properties" });
  const done = popup.getByRole("button", { name: "Done", exact: true });
  const condition = popup.getByLabel("Condition", { exact: true });
  await expect(condition).toBeFocused();
  await expect(done).toBeInViewport({ ratio: 1 });
  const location = popup.getByTitle(`${path}:8`, { exact: true });
  await expect(location.getByText(":8", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(popup.getByText("Condition", { exact: true })).toHaveCSS("font-size", "13px");

  await condition.fill("amount8 > 60");
  const log = popup.getByRole("textbox", { name: "Evaluate and log", exact: true });
  await log.fill("paid: {amount8}");
  await expect(location).toBeInViewport({ ratio: 1 });
  await expect(done).toBeInViewport({ ratio: 1 });
  await done.click();
  await expect(popup).toBeHidden();

  await open();
  await expect(condition).toHaveValue("amount8 > 60");
  await expect(log).toHaveValue("paid: {amount8}");
  await popup.getByRole("button", { name: /^More/ }).click();
  const dialog = page.getByRole("dialog", { name: "Breakpoints", exact: true });
  await expect(dialog.getByLabel("Condition", { exact: true })).toHaveValue("amount8 > 60");
});
