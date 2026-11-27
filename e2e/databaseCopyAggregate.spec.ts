import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Copy Aggregation Result copies the selection's Sum, or the aggregate picked in the context menu", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.clipboard_write_text = () => null;
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, RESULTS_VIEW } = await import(storePath);
    const { showServiceView } = await import(contributionsPath);
    const text = "SELECT city, amount FROM orders";
    useDatabase.setState({
      loaded: true,
      sources: [{ id: "shop", name: "Shop", driver: "postgres", readOnly: true }],
      consoles: { "shop-console.sql": "shop" },
      results: [
        {
          id: 1,
          title: "Result 1",
          path: "shop-console.sql",
          sourceId: "shop",
          outcome: {
            statement: { text, from: 0, to: text.length },
            error: null,
            result: {
              statement: text,
              columns: [
                { name: "city", typeName: "TEXT" },
                { name: "amount", typeName: "NUMERIC" },
              ],
              rows: [
                ["Oslo", "10"],
                ["Lima", "2.5"],
                ["Kyiv", null],
              ],
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
  const amounts = grid.getByRole("gridcell").filter({ hasText: /^(10|2\.5)$/ });
  await expect(amounts).toHaveCount(2);
  await amounts.first().click();
  await amounts.last().click({ modifiers: ["Shift"] });

  await page.keyboard.press("Meta+Shift+C");
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toEqual([{ text: "12.5" }]);

  await amounts.last().click({ button: "right", modifiers: ["Shift"] });
  await page.getByRole("menuitem", { name: "Copy Aggregation Result" }).click();
  await page.getByRole("menuitem", { name: /^Avg: 6\.25/ }).click();
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toEqual([{ text: "12.5" }, { text: "6.25" }]);
});
