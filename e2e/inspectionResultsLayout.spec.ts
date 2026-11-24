import { expect, stubDesktop, test } from "./fixtures";

test("inspection results keep source context and actions visible as the dock narrows", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  const relative = "modules/settlement/reconciliation/QuarterlySettlementReconciliationCoordinator.ts";
  const path = `/dev/acme-api/${relative}`;
  const title = "The estimated settlement total ignores the currency conversion for pending merchant payments";
  const detail = "Check the calculation before saving the reconciliation report.";
  await page.evaluate(async (path) => {
    const backend = "/src/editor/core/backend.ts";
    (await import(/* @vite-ignore */ backend))
      .docBackend()
      .files.set(path, "const amount = 100;\nconst exchangeRate = 3;\nconst estimate = amount;\n");
    const service = "/src/workbench/contributions.ts";
    await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
  }, path);
  await expect(page.locator(".cm-content")).toContainText("estimate");
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, relative, title, detail }) => {
      window.__ipc.handlers.inspect_code = ({ onEvent }) => {
        window.__ipc.send(onEvent, { type: "started", total: 1 });
        window.__ipc.send(onEvent, {
          type: "file",
          done: 1,
          file: {
            path,
            relPath: relative,
            diagnostics: [
              {
                range: { start: { line: 2, col: 6 }, end: { line: 2, col: 14 } },
                severity: "warning",
                message: `${title}\n${detail}`,
                source: "lint",
                code: "pending-currency-conversion",
              },
            ],
          },
        });
        window.__ipc.send(onEvent, {
          type: "done",
          summary: { files: 1, problems: 1, skipped: 0, failed: 0, cancelled: false, elapsedMs: 30 },
        });
      };
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("analyze.inspectFile");
    },
    { path, relative, title, detail },
  );

  const tree = page.getByRole("tree", { name: "Inspection results" });
  const problem = tree.getByRole("treeitem").filter({ hasText: title });
  await problem.click({ position: { x: 95, y: 12 } });
  const jump = page.getByRole("button", { name: "Jump to Source" });
  const message = page.getByText(detail, { exact: false }).filter({ visible: true }).last();
  expect((await jump.boundingBox())!.y).toBeLessThan((await message.boundingBox())!.y);
  const details = page.getByRole("region", { name: "Inspection details" });
  const quickFixes = details.getByRole("button", { name: "Show Quick Fixes" });
  await expect(details.getByText(`${relative}:3:7`)).toBeVisible();
  const split = page.getByRole("separator", { name: "Resize inspection panes" });
  await expect(split).toHaveAttribute("aria-valuenow", "50");
  await split.focus();
  await page.keyboard.press("ArrowRight");
  await expect(split).not.toHaveAttribute("aria-valuenow", "50");

  await page.setViewportSize({ width: 540, height: 680 });
  await expect(quickFixes).toBeInViewport({ ratio: 1 });
  await expect(jump).toBeInViewport({ ratio: 1 });
  const right = (await details.boundingBox())!;
  const jumpBounds = (await jump.boundingBox())!;
  expect(jumpBounds.x + jumpBounds.width).toBeLessThan(right.x + right.width);
  const file = tree.getByRole("treeitem").filter({ has: page.getByTitle(relative, { exact: true }) });
  const count = file.getByText("1", { exact: true });
  const fileBounds = (await file.boundingBox())!;
  const countBounds = (await count.boundingBox())!;
  expect(countBounds.x + countBounds.width).toBeLessThan(fileBounds.x + fileBounds.width);
  expect(await message.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await jump.click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const service = "/src/workbench/contributions.ts";
        const cursor = (await import(/* @vite-ignore */ service)).editorService().activeCursor();
        return { path: cursor?.path, line: cursor?.line, col: cursor?.col };
      }),
    )
    .toEqual({ path, line: 2, col: 6 });
});
