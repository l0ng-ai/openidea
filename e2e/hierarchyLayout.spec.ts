import type { EditorView } from "@codemirror/view";
import { expect, stubDesktop, test } from "./fixtures";

test("Hierarchy keeps source context and controls reachable in a narrow dock", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 940, height: 680 });
  const path = "/dev/acme-api/QuarterlySettlementReconciliationCoordinator.ts";
  const caller = "reconcileQuarterlySettlementForMerchantOrders";
  const context = "Checkout and settlement coordinator";
  await page.evaluate(
    async ({ path, caller }) => {
      const backend = "/src/editor/core/backend.ts";
      const { docBackend } = await import(/* @vite-ignore */ backend);
      docBackend().files.set(
        path,
        [
          "function settleOrder() {}",
          "",
          `function ${caller}() {`,
          "  settleOrder();",
          "  settleOrder();",
          "}",
          `function flushSettlementQueue() { ${caller}(); }`,
        ].join("\n"),
      );
      const service = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
    },
    { path, caller },
  );
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("settleOrder");
  await editor.evaluate((el) => {
    const view = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    view.dispatch({ selection: { anchor: 11 } });
    view.focus();
  });
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, caller, context }) => {
      const range = (line: number, col: number) => ({ start: { line, col }, end: { line, col: col + 5 } });
      const item = (name: string, line: number, detail: string, fromRanges: ReturnType<typeof range>[]) => ({
        name,
        path,
        detail,
        kind: "function",
        range: range(line, 0),
        selectionRange: range(line, 9),
        fromRanges,
      });
      window.__ipc.handlers.lsp_call_hierarchy = ({ pos }) => {
        const line = (pos as { line: number }).line;
        return {
          items:
            line === 0
              ? [item(caller, 2, context, [range(3, 2), range(4, 2)])]
              : [item("flushSettlementQueue", 6, "Queue processing", [range(6, 34)])],
          incomplete: null,
        };
      };
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("navigate.callHierarchy");
      const dock = "/src/workbench/toolwindows/store.ts";
      (await import(/* @vite-ignore */ dock)).setToolWindowSize("right", 136);
    },
    { path, caller, context },
  );

  const tree = page.getByRole("tree", { name: "Call hierarchy" });
  const row = tree.getByRole("treeitem").filter({ hasText: caller });
  await expect(row).toBeVisible();
  const detail = row.getByText(context, { exact: true });
  await expect.poll(() => detail.evaluate((el) => el.clientWidth)).toBeGreaterThan(100);
  expect((await row.getByText("(2 calls)", { exact: true }).boundingBox())!.x).toBeLessThan(
    (await detail.boundingBox())!.x,
  );
  const toolbar = page.getByRole("toolbar", { name: "Hierarchy actions" });
  expect(await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await tree.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  expect(await tree.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  await tree.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await row.click({ position: { x: 90, y: 12 } });
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem").filter({ hasText: "flushSettlementQueue" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const service = "/src/workbench/contributions.ts";
        const cursor = (await import(/* @vite-ignore */ service)).editorService().activeCursor();
        return { path: cursor?.path, line: cursor?.line, col: cursor?.col };
      }),
    )
    .toEqual({ path, line: 3, col: 2 });
});
