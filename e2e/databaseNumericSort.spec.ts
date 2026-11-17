import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const integers = ["9007199254740993", "9007199254740992", "-9007199254740992", "-9007199254740993"];
const decimals = ["1.0000000000000000002", "1.0000000000000000001", "-0.0000000000000000001", "0"];

async function seedResult(page: Page, values: string[], type: string) {
  await page.evaluate(
    async ({ values, type }) => {
      const storePath = "/src/features/database/store.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const { useDatabase, RESULTS_VIEW } = await import(storePath);
      const { showServiceView } = await import(contributionsPath);
      const text = "SELECT value FROM exact_numbers";
      useDatabase.setState({
        loaded: true,
        sources: [{ id: "exact", name: "Exact numbers", driver: "postgres", readOnly: true }],
        consoles: { "exact-console.sql": "exact" },
        results: [
          {
            id: 1,
            title: "Result 1",
            path: "exact-console.sql",
            sourceId: "exact",
            outcome: {
              statement: { text, from: 0, to: text.length },
              error: null,
              result: {
                statement: text,
                columns: [{ name: "value", typeName: type }],
                rows: values.map((value) => [value]),
                affected: null,
                hasMore: false,
                elapsedMs: 1,
                executionMs: 1,
              },
            },
            page: 0,
            pageSize: 500,
          },
        ],
        activeResult: 1,
      });
      showServiceView(RESULTS_VIEW);
    },
    { values, type },
  );
  await expect(page.getByRole("grid", { name: "Result 1", exact: true }).getByRole("gridcell")).toHaveCount(
    values.length,
  );
}

for (const [name, values, type, ascending] of [
  ["BIGINT", integers, "BIGINT", [integers[3]!, integers[2]!, integers[1]!, integers[0]!]],
  ["DECIMAL", decimals, "NUMERIC(38,19)", [decimals[2]!, decimals[3]!, decimals[1]!, decimals[0]!]],
] as const) {
  test(`${name}: result headers sort exact values ascending, descending and back to query order`, async ({
    workbench: page,
  }) => {
    await seedResult(page, [...values], type);
    const grid = page.getByRole("grid", { name: "Result 1", exact: true });
    const cells = grid.getByRole("gridcell");
    const header = grid.getByRole("columnheader", { name: /^value\b/ }).getByText("value", { exact: true });
    await expect(cells).toHaveText([...values]);
    await header.click();
    await expect(cells).toHaveText([...ascending]);
    await header.click();
    await expect(cells).toHaveText([...ascending].reverse());
    await header.click();
    await expect(cells).toHaveText([...values]);
  });
}

test("precise filter values are ordered and filtering composes with result sorting", async ({ workbench: page }) => {
  await seedResult(page, [...integers], "BIGINT");
  const grid = page.getByRole("grid", { name: "Result 1", exact: true });
  await grid.getByRole("button", { name: "Filter value", exact: true }).click();
  const values = page.getByRole("group", { name: "Values", exact: true });
  const ascending = [integers[3]!, integers[2]!, integers[1]!, integers[0]!];
  await expect(values.locator("label")).toHaveText(ascending);
  await values.getByRole("checkbox", { name: integers[3], exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await grid
    .getByRole("columnheader", { name: /^value\b/ })
    .getByText("value", { exact: true })
    .click();
  await expect(grid.getByRole("gridcell")).toHaveText(ascending.slice(1));
});

test("selection aggregates preserve exact minimum and maximum values", async ({ workbench: page }) => {
  await seedResult(page, [...decimals], "NUMERIC(38,19)");
  const grid = page.getByRole("grid", { name: "Result 1", exact: true });
  await grid.getByRole("gridcell").first().click();
  await grid
    .getByRole("gridcell")
    .last()
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Show Record / Value / Aggregates", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Value panel", exact: true });
  await panel.getByRole("tab", { name: "Aggregates", exact: true }).click();
  await expect(panel.getByRole("row", { name: `Min ${decimals[2]}`, exact: true })).toBeVisible();
  await expect(panel.getByRole("row", { name: `Max ${decimals[0]}`, exact: true })).toBeVisible();
});
