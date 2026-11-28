import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const source = "duckdb-sandbox";
const catalog = "archive.db:2026";
const path = "/app-data/consoles/db/duckdb-sandbox/console.sql";

test("completes and browses DuckDB attachments on one source", async ({ workbench: page }, info) => {
  await page.evaluate(async (path) => {
    const workbench = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ workbench);
    await editorService().openFile(path, { focus: true });
  }, path);
  await stubDesktop(page);
  await page.evaluate(
    async ({ source, catalog, path }) => {
      const column = { name: "Description", dataType: "VARCHAR", primaryKey: false, nullable: false, default: null };
      const details = { columns: [column], indexes: [], foreignKeys: [], triggers: [] };
      const orders = { name: "orders", kind: "table" };
      Object.assign(window.__ipc.handlers, {
        db_sources: () => [{ id: source, name: "DuckDB Demo", driver: "jdbc", vendor: "duckdb", url: "jdbc:duckdb:" }],
        db_connected: () => [source],
        db_connect: () => null,
        cancel_request: () => null,
        db_schemas: () => ["main"],
        db_databases: () => ({ current: "memory", names: ["memory", catalog] }),
        db_database_catalog: ({ database }: { database: string }) => [
          {
            name: "main",
            tables: database === catalog ? [orders, { name: "order audit", kind: "view" }] : [orders],
          },
        ],
        db_completion: () => ({
          defaultSchema: "main",
          tables: [{ schema: "main", ...orders, columns: [{ ...column, hasDefault: false }] }],
          foreignKeys: [],
        }),
        db_catalog_table_details: () => details,
        db_catalog_table_page: ({ catalog: selected }: { catalog: string }) => ({
          details,
          offset: 0,
          result: {
            statement: `SELECT * FROM "${selected}"."main"."orders"`,
            columns: [{ name: column.name, typeName: column.dataType }],
            rows: [[selected === "memory" ? "Current order" : "Archived order"]],
            elapsedMs: 1,
            executionMs: 1,
            hasMore: false,
            truncated: [],
          },
        }),
      });
      const database = "/src/features/database/store.ts";
      const workbench = "/src/workbench/contributions.ts";
      const { bindConsole, loadSources } = await import(/* @vite-ignore */ database);
      const { toolWindowService } = await import(/* @vite-ignore */ workbench);
      await loadSources();
      bindConsole(path, source);
      toolWindowService().show("database");
    },
    { source, catalog, path },
  );

  const tree = page.getByRole("tree", { name: "Data sources" });
  const expand = (label: string) =>
    tree
      .getByText(label, { exact: true })
      .last()
      .locator("xpath=ancestor::*[@role='treeitem'][1]")
      .locator("[data-tree-toggle]")
      .click();
  await expand("DuckDB Demo");
  await expand("memory");
  await expand("main");
  await expand("tables");
  await tree.getByText("orders", { exact: true }).dblclick();
  await expect(page.getByRole("gridcell", { name: "Current order" })).toBeVisible();

  await expand(catalog);
  await expand("main");
  await expand("tables");
  await tree.getByText("orders", { exact: true }).last().dblclick();
  await expect(page.getByRole("gridcell", { name: "Archived order" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "memory.main.orders", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: `${catalog}.main.orders`, exact: true })).toBeVisible();
  const pages = await ipcCalls(page, "db_catalog_table_page");
  expect(pages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source, catalog: "memory", schema: "main", table: "orders" }),
      expect.objectContaining({ id: source, catalog, schema: "main", table: "orders" }),
    ]),
  );
  expect(await ipcCalls(page, "db_table_page")).toEqual([]);
  expect((await ipcCalls(page, "db_connect")).every(({ id }) => id === source)).toBe(true);
  await page.screenshot({ path: info.outputPath("catalog-tree-after.png"), animations: "disabled" });

  await page.getByRole("tab", { name: "console [DuckDB Demo]" }).click();
  const editor = page.locator(".cm-content[contenteditable=true]").first();
  const query = `SELECT * EXCLUDE (InternalNote)\nFROM "${catalog}".main.`;
  const completion = page.locator(".cm-tooltip-autocomplete");
  const showCompletion = async () => {
    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(query);
    await page.keyboard.press("Control+Space");
    await expect(completion.getByText("orders", { exact: true })).toBeVisible();
    await expect(completion.getByText("order audit", { exact: true })).toBeVisible();
  };
  await showCompletion();
  await completion.getByText("orders", { exact: true }).click();
  await expect(editor).toContainText(`FROM "${catalog}".main.orders`);
  await showCompletion();
  await page.screenshot({ path: info.outputPath("catalog-completion-after.png"), animations: "disabled" });
});
