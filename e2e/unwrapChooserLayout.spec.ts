import { expect, stubDesktop, test } from "./fixtures";

const source =
  "export function addActiveOrders(orders: Order[], basket: Basket) {\n  for (const order of orders) {\n    if (order.isEligibleForQuarterlySettlement) {\n      basket.add(order.total);\n    }\n  }\n}\n";
const file = "/dev/acme-api/orders.ts";
const title = "Choose the Statement to Unwrap/Remove";

test("Unwrap/Remove previews the selected branch in a compact chooser", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 620, height: 640 });
  await page.evaluate(
    async ({ file, source }) => {
      const backend = "/src/editor/core/backend.ts";
      (await import(/* @vite-ignore */ backend)).docBackend().files.set(file, source);
      const contributions = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ contributions)).editorService().openFile(file);
    },
    { file, source },
  );
  const editor = page.locator(".cm-editor").first();
  const content = editor.locator(".cm-content");
  await expect(content).toContainText("basket.add(order.total)");
  await stubDesktop(page);
  await page.evaluate((source) => {
    const lines = source.split("\n");
    const node = (kind: string, from: number, start: number, to: number, field: string | null = null) => ({
      kind,
      range: { start: { line: from, col: start }, end: { line: to, col: lines[to]!.length } },
      field,
      error: false,
      missing: false,
    });
    window.__ipc.handlers.syntax_support = () => ({ tree: true });
    window.__ipc.handlers.syntax_node_at = () => ({
      node: node("expression_statement", 3, 6, 3),
      ancestors: [
        node("statement_block", 2, lines[2]!.length - 1, 4, "consequence"),
        node("if_statement", 2, 4, 4),
        node("statement_block", 1, lines[1]!.length - 1, 5, "body"),
        node("for_in_statement", 1, 2, 5),
      ],
    });
  }, source);

  const target = content.locator(".cm-line", { hasText: "basket.add(order.total)" });
  await target.click();
  await page.keyboard.press("Meta+Shift+Delete");
  const popup = page.getByRole("dialog", { name: title, exact: true });
  const options = popup.getByRole("option");
  await expect(options).toHaveCount(2);
  expect((await popup.boundingBox())!.width).toBeLessThan(330);
  await expect(options).toHaveText(["Unwrap 'if'", "Unwrap 'for'"]);
  await expect(popup).toBeInViewport({ ratio: 1 });
  await expect(options.first()).toHaveCSS("font-size", "13px");

  const retained = editor.locator(".cm-lsp-chooser-highlight");
  const removed = editor.locator(".cm-lsp-chooser-removed");
  await expect(retained).toHaveText(["basket.add(order.total);"]);
  await expect(removed.first()).toContainText("if (order.isEligible");
  await page.keyboard.press("ArrowDown");
  await expect(removed.first()).toContainText("for (const order");
  await expect(retained.first()).toContainText("if (order.isEligible");
  await options.first().hover();
  await expect(removed.first()).toContainText("if (order.isEligible");

  await page.keyboard.type("zzz");
  await expect(options).toHaveCount(0);
  await expect(retained).toHaveCount(0);
  await expect(removed).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(content).toBeFocused();
  await expect(content).toContainText("if (order.isEligible");

  await page.keyboard.press("Meta+Shift+Delete");
  await expect(options).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect(content).not.toContainText("for (const order");
  await expect(content).toContainText("if (order.isEligible");
  await expect(removed).toHaveCount(0);
  await expect(retained).toHaveCount(0);
});
