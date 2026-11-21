import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const text =
  "export function settlement(invoice: Invoice) {\n  return calculateSettlement(\n    invoice.regionalInvoiceSubtotalInCents,\n    invoice.adjustmentForQuarterlyTaxInCents,\n  );\n}\n";
const file = "/dev/acme-api/settlement.ts";
const from = { line: 1, col: 9 };
const outerRange = { start: from, end: { line: 4, col: 3 } };

for (const route of ["action", "syntax fallback"] as const) {
  test(`Expressions stays compact and previews full source from the ${route}`, async ({ workbench: page }) => {
    await page.setViewportSize({ width: 620, height: 640 });
    await page.evaluate(
      async ({ file, text }) => {
        const backend = "/src/editor/core/backend.ts";
        (await import(/* @vite-ignore */ backend)).docBackend().files.set(file, text);
        const contributions = "/src/workbench/contributions.ts";
        await (await import(/* @vite-ignore */ contributions)).editorService().openFile(file);
      },
      { file, text },
    );

    const editor = page.locator(".cm-editor").first();
    const content = editor.locator(".cm-content");
    const line = content.locator(".cm-line", { hasText: "regionalInvoiceSubtotalInCents" });
    await expect(line).toBeVisible();
    await stubDesktop(page);
    await page.evaluate(
      ({ outerRange }) => {
        const inner = {
          kind: "member_expression",
          range: { start: { line: 2, col: 4 }, end: { line: 2, col: 42 } },
          field: null,
          error: false,
          missing: false,
          hasError: false,
        };
        const outer = { ...inner, kind: "call_expression", range: outerRange };
        window.__ipc.handlers.syntax_support = () => ({ tree: true });
        window.__ipc.handlers.syntax_expression_at = () => ({
          expression: inner,
          exact: false,
          candidates: [inner, outer],
          statement: null,
          block: null,
          functionBoundary: null,
          hasError: false,
        });
        window.__ipc.handlers.lsp_code_action_query = () => ({ actions: [], advertisedKinds: null });
        window.__ipc.handlers.syntax_node_at = () => null;
      },
      { outerRange },
    );

    const start = async () => {
      await line.click();
      if (route === "action") {
        await page.keyboard.press("Meta+Alt+v");
      } else {
        await page.evaluate(async () => {
          const module = "/src/editor/refactor/introduce.ts";
          const api = "/src/editor/api.ts";
          const { introduceFallback } = await import(/* @vite-ignore */ module);
          const { activeEditor } = await import(/* @vite-ignore */ api);
          void introduceFallback(activeEditor().view, "variable", "notReady");
        });
      }
    };

    await start();
    const popup = page.getByRole("dialog", { name: "Expressions", exact: true });
    const options = popup.getByRole("option");
    const preview = editor.locator(".cm-lsp-chooser-highlight");
    await expect(options).toHaveCount(2);
    expect((await popup.boundingBox())!.width).toBeLessThan(380);
    await expect(options).toHaveText(["invoice.regionalInvoiceSubtotalInCents", "calculateSettlement(…"]);
    await expect(options.last()).toHaveCSS("font-size", "13px");
    await expect(popup).toBeInViewport({ ratio: 1 });
    await expect(preview).toHaveText(["invoice.regionalInvoiceSubtotalInCents"]);

    await page.keyboard.type("calculate");
    await expect(options).toHaveText(["calculateSettlement(…"]);
    await expect(preview.first()).toHaveText("calculateSettlement(");
    await expect(preview.nth(2)).toContainText("invoice.adjustmentForQuarterlyTaxInCents");
    await page.keyboard.type("zzz");
    await expect(options).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(content).toBeFocused();

    await start();
    await expect(options).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(popup).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    const command = route === "action" ? "lsp_code_action_query" : "syntax_node_at";
    await expect.poll(() => ipcCalls(page, command)).toMatchObject([{ range: outerRange }]);
  });
}
