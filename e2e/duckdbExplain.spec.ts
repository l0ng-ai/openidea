import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("opens a named DuckDB query plan without executing the statement", async ({ workbench: page }, info) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const database = "/src/features/database/store.ts";
    const workbench = "/src/workbench/contributions.ts";
    const { useDatabase, bindConsole } = await import(database);
    const { editorService } = await import(workbench);
    const path = "/dev/acme-api/orders.sql";
    useDatabase.setState({
      loaded: true,
      sources: [{ id: "shop", name: "Shop · DuckDB", driver: "jdbc", vendor: "duckdb" }],
      completion: { shop: { defaultSchema: "main", tables: [], foreignKeys: [] } },
    });
    bindConsole(path, "shop");
    Object.assign(window.__ipc.handlers, {
      db_statements: ({ text }: { text: string }) => [{ text, from: 0, to: text.length }],
      db_connected: () => ["shop"],
      db_explain: () => [
        {
          parent: null,
          operation: "HASH_JOIN",
          params: "customer_id = id",
          properties: [{ name: "Join Type", value: "INNER" }],
        },
        { parent: 0, operation: "SEQ_SCAN", params: "orders", properties: [{ name: "Table", value: "orders" }] },
        { parent: 0, operation: "SEQ_SCAN", params: "customers", properties: [{ name: "Table", value: "customers" }] },
      ],
    });
    await editorService().openFile(path, { focus: true });
  });
  const editor = page.locator(".cm-editor:visible .cm-content[contenteditable=true]");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(
    "SELECT orders.id, customers.name\nFROM orders\nJOIN customers ON orders.customer_id = customers.id;",
  );
  const toolbar = page.getByRole("toolbar", { name: "Query Console" });
  await toolbar.getByRole("button", { name: "Explain Plan" }).click();
  const tree = page.getByRole("tree", { name: "Query plan" });
  await expect(tree).toContainText("HASH_JOIN");
  await tree.getByText("HASH_JOIN", { exact: true }).click();
  await expect(page.getByRole("table", { name: "Plan node properties" })).toContainText("INNER");
  await expect(tree).toContainText("customers");
  expect(await ipcCalls(page, "db_explain")).toHaveLength(1);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(0);
  expect(await ipcCalls(page, "db_execute_stream")).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("duckdb-explain.png"), animations: "disabled" });
});
