import { expect, test } from "./fixtures";

test("result grid keeps row numbers at the left edge while scrolling sideways", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, RESULTS_VIEW } = await import(storePath);
    const { showServiceView } = await import(contributionsPath);
    const text = "SELECT * FROM wide";
    const columns = Array.from({ length: 30 }, (_, i) => ({ name: `column_${i}`, typeName: "TEXT" }));
    useDatabase.setState({
      loaded: true,
      sources: [{ id: "wide", name: "Wide", driver: "postgres", readOnly: true }],
      consoles: { "wide-console.sql": "wide" },
      results: [
        {
          id: 1,
          title: "Result 1",
          path: "wide-console.sql",
          sourceId: "wide",
          outcome: {
            statement: { text, from: 0, to: text.length },
            error: null,
            result: {
              statement: text,
              columns,
              rows: Array.from({ length: 3 }, (_, r) => columns.map((_, c) => `value ${r}:${c} padded out`)),
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
  });
  const grid = page.getByRole("grid", { name: "Result 1", exact: true });
  await expect(grid.getByRole("gridcell").first()).toBeVisible();
  const offsets = () =>
    grid.evaluate((el) => {
      const left = el.getBoundingClientRect().left;
      const rows = [...el.querySelectorAll('[role="row"]')];
      return rows.map((row) => Math.round(row.firstElementChild!.getBoundingClientRect().left - left));
    });
  expect(await offsets()).toEqual([0, 0, 0, 0]);
  await grid.evaluate((el) => {
    el.scrollLeft = 1500;
  });
  expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(1000);
  // Header and body row numbers stay put; the first data column has scrolled away under them.
  expect(await offsets()).toEqual([0, 0, 0, 0]);
  const firstCell = await grid
    .getByRole("gridcell")
    .first()
    .evaluate((el) => el.getBoundingClientRect().right);
  const gridLeft = await grid.evaluate((el) => el.getBoundingClientRect().left);
  expect(firstCell).toBeLessThan(gridLeft);
  // The number is drawn on top, not under the cells scrolled beneath it.
  const hit = await grid.evaluate((el) => {
    const number = el.querySelectorAll('[role="row"]')[1]!.firstElementChild!;
    const box = number.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === number;
  });
  expect(hit).toBe(true);
});
