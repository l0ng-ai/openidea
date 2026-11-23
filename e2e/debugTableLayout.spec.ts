import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openTable(page: Page, columns: number) {
  await stubDesktop(page);
  await page.evaluate(async (columns) => {
    window.__ipc.handlers.debug_evaluate_in = ({ expression }) => {
      const query = String(expression);
      const sliced = query.includes("totals.iloc[:2, :2]");
      const visibleColumns = sliced ? 2 : Math.min(30, columns);
      const columnsInFrame = sliced ? 2 : columns;
      const start = query.includes("100, 100,") ? 100 : 0;
      const rows = sliced ? 2 : 220;
      const count = sliced ? 2 : 100;
      const result = query.includes("missing_table")
        ? { error: "NameError: missing_table" }
        : {
            kind: "frame",
            shape: [rows, columnsInFrame],
            rows,
            columns: columnsInFrame,
            headers: Array.from({ length: visibleColumns }, (_, i) => `Amount ${i + 1}`),
            dtypes: Array.from({ length: visibleColumns }, () => "int64"),
            index: Array.from({ length: count }, (_, i) => String(i + start)),
            cells: Array.from({ length: count }, (_, row) =>
              Array.from({ length: visibleColumns }, (_, column) => String((row + start + 1) * 10 + column)),
            ),
          };
      return {
        name: "",
        value: JSON.stringify(JSON.stringify(result)),
        typeName: "str",
        variablesReference: 0,
        evaluateName: null,
      };
    };
    const stateModule = "/src/features/debugger/state.ts";
    const overlaysModule = "/src/features/debugger/ui/popoverStore.ts";
    const { adoptSession } = await import(/* @vite-ignore */ stateModule);
    const { openTableView } = await import(/* @vite-ignore */ overlaysModule);
    adoptSession(91, { name: "Settlement review", adapter: "debugpy", status: "paused", selectedFrame: 11 });
    openTableView("totals", 91);
  }, columns);
  const dialog = page.getByRole("dialog", { name: "Table view of totals", exact: true });
  await expect(dialog.getByRole("table")).toBeVisible();
  return dialog;
}

test("View as Table gives the grid the dialog width and puts the expression below it", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  const dialog = await openTable(page, 3);
  const scroll = dialog.getByRole("region", { name: "Table", exact: true });
  const grid = dialog.getByRole("table");
  const expression = dialog.getByRole("textbox", { name: "Expression", exact: true });
  const shape = dialog.getByText("Shape (220, 3)", { exact: true });
  const body = (await scroll.boundingBox())!;
  const input = (await expression.boundingBox())!;
  expect(input.y).toBeGreaterThan(body.y + body.height);
  expect((await shape.boundingBox())!.y).toBeLessThan(body.y);
  expect(Math.abs((await grid.boundingBox())!.width - (await scroll.evaluate((el) => el.clientWidth)))).toBeLessThan(1);
  expect((await dialog.boundingBox())!.width).toBeCloseTo(700, 0);
  await expect(expression).toBeFocused();
  await expect(grid).toHaveCSS("font-family", /Inter/);
  await expect(grid.getByRole("columnheader").nth(1)).toHaveCSS("text-align", "center");
  await expect(grid.getByRole("rowheader").first()).toHaveCSS("text-align", "center");
  await expect(grid.getByRole("cell").first()).toHaveCSS("text-align", /^(start|left)$/);
});

test("View as Table keeps paging, slice input and Close usable in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 450, height: 620 });
  const dialog = await openTable(page, 36);
  const expression = dialog.getByRole("textbox", { name: "Expression", exact: true });
  const scroll = dialog.getByRole("region", { name: "Table", exact: true });
  const rows = dialog.getByRole("button", { name: "Next Rows", exact: true });
  const columns = dialog.getByRole("button", { name: "Next Columns", exact: true });
  const close = dialog.getByRole("button", { name: "Close", exact: true }).filter({ hasText: /^Close$/ });
  const input = (await expression.boundingBox())!;
  const grid = (await scroll.boundingBox())!;
  expect(input.y).toBeGreaterThan(grid.y + grid.height);
  expect(input.width).toBeCloseTo(grid.width, 0);
  for (const control of [expression, rows, columns, close]) await expect(control).toBeInViewport({ ratio: 0.98 });
  await scroll.evaluate((el) => {
    el.scrollLeft = 300;
    el.scrollTop = 150;
  });
  await expect(dialog.getByRole("rowheader").filter({ hasText: /^9$/ })).toBeInViewport({ ratio: 0.98 });
  await rows.click();
  await expect(dialog.getByText("Rows 101–200 of 220", { exact: true })).toBeVisible();
  await expect
    .poll(() => ipcCalls(page, "debug_evaluate_in"))
    .toContainEqual(expect.objectContaining({ expression: expect.stringContaining("100, 100, 0, 30") }));
  await expression.fill("totals.iloc[:2, :2]");
  await expression.press("Enter");
  const sliced = page.getByRole("dialog", { name: "Table view of totals.iloc[:2, :2]", exact: true });
  await expect(sliced.getByText("Shape (2, 2)", { exact: true })).toBeVisible();
  const slicedExpression = sliced.getByRole("textbox", { name: "Expression", exact: true });
  await slicedExpression.fill("missing_table");
  await slicedExpression.press("Enter");
  const failed = page.getByRole("dialog", { name: "Table view of missing_table", exact: true });
  const alert = failed.getByRole("alert");
  await expect(alert).toHaveText("NameError: missing_table");
  expect((await alert.boundingBox())!.y).toBeGreaterThan(
    (await failed.getByRole("textbox", { name: "Expression", exact: true }).boundingBox())!.y,
  );
  await failed
    .getByRole("button", { name: "Close", exact: true })
    .filter({ hasText: /^Close$/ })
    .click();
  await expect(failed).toHaveCount(0);
});
