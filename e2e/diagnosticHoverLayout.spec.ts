import { expect, stubDesktop, test } from "./fixtures";

test("long diagnostics and quick fixes wrap within a narrow editor hover", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 520, height: 580 });
  const path = "/dev/acme-api/Settlement.ts";
  const identifier = "QuarterlyCrossBorderSettlementProjection".repeat(4);
  const message = `Cannot resolve ${identifier}.\nCheck the settlement calculation.`;
  const title = `Replace with ${identifier}Result`;
  const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 7 } };
  await page.evaluate(async (path) => {
    const backend = "/src/editor/core/backend.ts";
    (await import(/* @vite-ignore */ backend)).docBackend().files.set(path, "pending();\n");
    const service = "/src/workbench/contributions.ts";
    await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
  }, path);
  await expect(page.locator(".cm-content")).toContainText("pending()");
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, message, title, range }) => {
      window.__ipc.handlers.lsp_hover = () => null;
      window.__ipc.handlers.lsp_code_actions = () => [
        {
          title,
          kind: "quickfix",
          isPreferred: true,
          disabledReason: null,
          edit: {
            files: [{ kind: "edit", path, edits: [{ range, new_text: "settled" }] }],
          },
          command: null,
          data: null,
          server: 1,
        },
      ];
      const diagnostic = "/src/editor/lsp/diagnostics.ts";
      (await import(/* @vite-ignore */ diagnostic)).setFileDiagnostics(path, "settlement-lint", [
        { severity: "error", message, range, source: "settlement-lint", code: "missing-model" },
        { severity: "hint", message: "Review the reported total.", range, source: "settlement-lint", code: "review" },
      ]);
    },
    { path, message, title, range },
  );

  await page.locator(".cm-content .cm-lintRange-error").hover();
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover).toBeVisible();
  const fix = hover.getByRole("button", { name: new RegExp(`^${title}`) });
  await expect(fix).toBeVisible();
  expect(await hover.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const messageText = hover.locator(".cm-lsp-diag-message").first();
  await expect(messageText).toHaveText(message);
  await expect(messageText).toHaveCSS("font-size", "13px");
  const shortcut = fix.locator(".cm-lsp-diag-shortcut");
  await expect(shortcut).toBeVisible();
  await expect(shortcut).toHaveCSS("font-size", "12px");
  const more = hover.getByRole("button", { name: "More actions…", exact: true }).first();
  await expect(more).toBeInViewport({ ratio: 1 });
  const outer = (await hover.boundingBox())!;
  const action = (await fix.boundingBox())!;
  const editor = (await page.locator(".cm-editor").boundingBox())!;
  expect(outer.x + outer.width).toBeLessThanOrEqual(editor.x + editor.width + 1);
  expect(action.x + action.width).toBeLessThanOrEqual(outer.x + outer.width);
  await more.click();
  const intentions = page.getByRole("dialog", { name: "Intentions", exact: true });
  await expect(intentions.getByRole("option", { name: title })).toBeVisible();
});
