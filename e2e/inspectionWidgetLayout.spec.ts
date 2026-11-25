import { expect, test } from "./fixtures";

test("inspection counts fit split editors and keep diagnostic navigation reachable", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const contributions = "/src/workbench/contributions.ts";
    const diagnostics = "/src/editor/lsp/diagnostics.ts";
    const { docBackend } = await import(/* @vite-ignore */ backend);
    const { editorService } = await import(/* @vite-ignore */ contributions);
    const { setFileDiagnostics } = await import(/* @vite-ignore */ diagnostics);
    const path = "/dev/acme-api/settlement-checks.ts";
    docBackend().files.set(
      path,
      Array.from({ length: 16 }, (_, index) => `export const ledgerRow${index} = ${index};`).join("\n"),
    );
    await editorService().openFile(path);
    setFileDiagnostics(
      path,
      "settlement-checks",
      ["error", "error", "warning", "warning", "warning", "info", "info", "info", "info", "hint"].map(
        (severity, index) => ({
          severity,
          typo: severity === "hint",
          message: `Check ledger row ${index + 1}`,
          range: { start: { line: index + 1, col: 13 }, end: { line: index + 1, col: 23 } },
        }),
      ),
    );
  });

  const toolbars = page.getByRole("toolbar", { name: "Inspections", exact: true });
  const toolbar = toolbars.first();
  const summaryLabel = "2 errors, 3 warnings, 4 weak warnings, 1 typos — open Problems";
  const summary = toolbar.getByRole("button", { name: summaryLabel });
  const counts = toolbar.locator(".cm-openidea-inspection-counts");
  const total = toolbar.locator(".cm-openidea-inspection-total");
  const next = toolbar.getByRole("button", { name: /^Next Highlighted Error/ });
  const previous = toolbar.getByRole("button", { name: /^Previous Highlighted Error/ });
  await expect(counts).toBeVisible();
  await expect(counts.locator(".cm-openidea-inspection-count")).toHaveText(["2", "3", "4", "1"]);
  await expect(summary).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(total).toBeHidden();

  await page.getByRole("button", { name: "Split Right", exact: true }).click();
  await expect(toolbars).toHaveCount(2);
  await page.setViewportSize({ width: 560, height: 560 });
  await expect(total).toBeVisible();
  await expect(total).toHaveText("10");
  expect(await total.locator("svg").innerHTML()).not.toEqual(
    await counts.locator(".cm-openidea-inspection-error svg").innerHTML(),
  );
  await expect(counts).toBeHidden();
  await expect(summary).toHaveAttribute("title", summaryLabel);
  await expect(next).toBeInViewport({ ratio: 1 });
  await expect(previous).toBeInViewport({ ratio: 1 });
  const editor = page.locator(".cm-editor").first();
  const [widget, pane] = await Promise.all([toolbar.boundingBox(), editor.boundingBox()]);
  expect(widget!.x).toBeGreaterThanOrEqual(pane!.x);
  expect(widget!.x + widget!.width).toBeLessThanOrEqual(pane!.x + pane!.width);

  await next.click();
  await expect(editor.locator(".cm-activeLine")).toContainText("ledgerRow1");
  await next.click();
  await expect(editor.locator(".cm-activeLine")).toContainText("ledgerRow2");
  await previous.click();
  await expect(editor.locator(".cm-activeLine")).toContainText("ledgerRow1");
  await page.setViewportSize({ width: 1200, height: 780 });
  await expect(counts).toBeVisible();
  await expect(total).toBeHidden();
  await summary.click();
  await expect(page.getByRole("region", { name: "Problems", exact: true })).toBeVisible();
});
