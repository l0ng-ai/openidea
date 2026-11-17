import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const cases = [
  { name: "positive fraction", count: 8192, total: "1", expected: "0.0001220703125" },
  { name: "negative fraction", count: 8192, total: "-1", expected: "-0.0001220703125" },
  { name: "integer result", count: 8192, total: "10000000000000000", expected: "1220703125000" },
  { name: "cancelled divisor factor", count: 24576, total: "3", expected: "0.0001220703125" },
];

async function seedResult(page: Page, count: number, total: string, chart: boolean) {
  await page.evaluate(
    async ({ count, total, chart }) => {
      const storePath = "/src/features/database/store.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const { useDatabase, RESULTS_VIEW } = await import(storePath);
      const { showServiceView } = await import(contributionsPath);
      const values = [total, ...Array<string>(count - 1).fill("0"), null, null];
      const columns = [{ name: "value", typeName: "NUMERIC" }];
      if (chart) columns.unshift({ name: "category", typeName: "TEXT" });
      const rows = values.map((value) => (chart ? ["all", value] : [value]));
      const text = "SELECT value FROM finite_means";
      useDatabase.setState({
        loaded: true,
        sources: [{ id: "finite", name: "Finite means", driver: "postgres", readOnly: true }],
        consoles: { "finite-means.sql": "finite" },
        results: [
          {
            id: 1,
            title: "Result 1",
            path: "finite-means.sql",
            sourceId: "finite",
            outcome: {
              statement: { text, from: 0, to: text.length },
              error: null,
              result: {
                statement: text,
                columns,
                rows,
                affected: null,
                hasMore: false,
                elapsedMs: 1,
                executionMs: 1,
              },
            },
            page: 0,
            pageSize: rows.length,
          },
        ],
        activeResult: 1,
      });
      showServiceView(RESULTS_VIEW);
    },
    { count, total, chart },
  );
  await expect(page.getByRole("grid", { name: "Result 1", exact: true }).getByRole("gridcell").first()).toBeVisible();
}

for (const { name, count, total, expected } of cases) {
  test(`selection mean stays exact: ${name}`, async ({ workbench: page }) => {
    await seedResult(page, count, total, false);
    const grid = page.getByRole("grid", { name: "Result 1", exact: true });
    await grid.getByRole("gridcell").first().click();
    await page.keyboard.press("Meta+a");
    await page.getByRole("button", { name: "Show Record / Value / Aggregates", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Value panel", exact: true });
    await panel.getByRole("tab", { name: "Aggregates", exact: true }).click();
    await expect(panel.getByRole("row", { name: /^Avg / }).getByRole("cell")).toHaveText(expected);
    await expect(panel.getByRole("row", { name: "Nulls 2", exact: true })).toBeVisible();
  });

  test(`chart mean stays exact: ${name}`, async ({ workbench: page }) => {
    await seedResult(page, count, total, true);
    await page.getByRole("button", { name: "Chart", exact: true }).click();
    const chart = page.getByRole("img", { name: "value (mean) by category", exact: true });
    await expect(chart).toBeVisible();
    await expect(chart.locator("rect title")).toHaveText(`all: ${expected}`);
  });
}
