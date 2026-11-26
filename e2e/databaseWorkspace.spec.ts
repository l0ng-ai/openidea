import type { Locator, Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function setupWorkspace(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const store = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ store);
    const sources = [
      { id: "accounts", name: "Accounts · PostgreSQL", driver: "postgres" },
      { id: "events", name: "Events · ClickHouse", driver: "clickhouse" },
    ];
    const table = (schema: string, name: string) => ({ schema, name, kind: "table", columns: [] });
    const completion = {
      accounts: {
        defaultSchema: "public",
        tables: [
          table("public", "customers"),
          table("legacy", "customers"),
          { ...table("public", "customers_view"), kind: "view" },
        ],
        foreignKeys: [],
      },
      events: {
        defaultSchema: "events",
        tables: [table("events", "purchases")],
        foreignKeys: [],
      },
    };
    useDatabase.setState({ sources });
    Object.assign(window.__ipc.handlers, {
      db_sources: () => sources,
      db_connected: () => [],
      db_completion: ({ id }: { id: keyof typeof completion }) => completion[id],
      db_jdbc_drivers: () =>
        [
          { id: "duck", name: "DuckDB JDBC" },
          { id: "duck-local", name: "DuckDB Local" },
        ].map((driver) => ({
          ...driver,
          className: "org.duckdb.DuckDBDriver",
          vendor: "duckdb",
          jars: [],
          urlTemplate: "jdbc:duckdb:",
        })),
      db_workspace_join: () => ({
        statement: "",
        columns: [
          { name: "id", typeName: "BIGINT" },
          { name: "customer", typeName: "VARCHAR" },
          { name: "customer_id", typeName: "BIGINT" },
          { name: "amount", typeName: "DECIMAL(32,6)" },
          { name: "note", typeName: "VARCHAR" },
        ],
        rows: Array.from({ length: 501 }, (_, i) => {
          const id = (9_007_199_254_740_993n + BigInt(i)).toString();
          return [
            id,
            i === 500 ? "Last customer" : "Customer " + (i + 1),
            id,
            "123456789012345678.000001",
            i === 0 ? null : "",
          ];
        }),
        hasMore: false,
        affected: null,
        elapsedMs: 42,
        executionMs: null,
        truncated: [],
      }),
    });
  });
}

async function openWorkspace(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("db.queryWorkspace");
  });
  return page.getByRole("region", { name: "Query Workspace" });
}

async function selectSources(page: Page, workspace: Locator) {
  await workspace.getByRole("button", { name: "Left data source" }).click();
  await page.getByRole("option", { name: "Accounts · PostgreSQL" }).click();
  await workspace.getByRole("button", { name: "Right data source" }).click();
  await page.getByRole("option", { name: "Events · ClickHouse" }).click();
}

test("completes qualified references and pages the same workspace result", async ({ workbench: page }, info) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("db.showToolWindow");
  });
  const newButton = page
    .getByRole("toolbar", { name: "Database actions" })
    .getByRole("button", { name: "New", exact: true });
  await newButton.click();
  await page.getByRole("menuitem", { name: "Query Workspace", exact: true }).click();

  const workspace = page.getByRole("region", { name: "Query Workspace" });
  await expect(workspace.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await selectSources(page, workspace);
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText("SELECT * FROM #");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: "#right", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "#left", exact: true }).click();
  await page.keyboard.insertText(".");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /#left\.legacy\.customers/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /customers_view/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("workspace-completion.png"), animations: "disabled" });
  await page.getByRole("option", { name: /#left\.public\.customers/ }).click();
  await page.keyboard.insertText(" a\nJOIN #right.events.");
  await editor.press("Control+Space");
  await page.getByRole("option", { name: /#right\.events\.purchases/ }).click();
  await page.keyboard.insertText(" b ON a.id = b.customer_id");
  await editor.press("Meta+Enter");

  const grid = workspace.getByRole("grid");
  await expect(grid.getByText("Customer 1", { exact: true })).toBeVisible();
  await expect(grid.getByText("9007199254740993", { exact: true })).toHaveCount(2);
  await expect(grid.getByText("123456789012345678.000001", { exact: true }).first()).toBeVisible();
  await expect(grid.getByText("<null>", { exact: true })).toBeVisible();
  expect((await ipcCalls(page, "db_workspace_join"))[0]).toMatchObject({
    driver: "duck",
    left: { sourceId: "accounts", database: "", schema: "public", table: "customers", key: "id" },
    right: { sourceId: "events", database: "events", schema: "events", table: "purchases", key: "customer_id" },
  });
  expect(await ipcCalls(page, "db_completion")).toEqual([{ id: "accounts" }, { id: "events" }]);
  await workspace.getByRole("button", { name: "Next Page" }).click();
  await expect(grid.getByText("Last customer", { exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Next Page" })).toBeDisabled();
  await workspace.getByRole("button", { name: "Previous Page" }).click();
  await expect(grid.getByText("Customer 1", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(1);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("workspace-join.png"), animations: "disabled" });
});

test("cancels the active request and surfaces parser, source and limit errors", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  await selectSources(page, workspace);
  const run = workspace.getByRole("button", { name: "Run", exact: true });
  const alert = workspace.getByRole("alert");
  const editor = workspace.getByLabel("Workspace SQL");
  const initialSql = await editor.innerText();
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText("DELETE FROM #left.public.customers");
  await run.click();
  await expect(alert).toHaveText("Expected SELECT in the workspace query.");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);

  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(initialSql);
  await page.evaluate(() => {
    let active: { id: unknown; reject: (error: unknown) => void } | undefined;
    window.__ipc.handlers.db_workspace_join = ({ request }) =>
      new Promise((_, reject) => {
        active = { id: request, reject };
      });
    window.__ipc.handlers.cancel_request = ({ id }) => {
      if (active?.id !== id) throw new Error("Unexpected cancellation request.");
      active?.reject({ kind: "cancelled", message: "Operation cancelled", data: null });
    };
  });
  await run.click();
  await expect(workspace.getByText("Running query", { exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Left data source" })).toBeDisabled();
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(alert).toHaveText("Cancelled");
  await expect(run).toBeEnabled();
  expect(await ipcCalls(page, "cancel_request")).toEqual([
    { id: (await ipcCalls(page, "db_workspace_join"))[0]!.request },
  ]);

  for (const message of [
    "Could not connect to Events",
    "Workspace input exceeds the source row limit",
    "Workspace result exceeds 100,000 rows",
  ]) {
    await page.evaluate((message) => {
      window.__ipc.handlers.db_workspace_join = () => {
        throw { kind: "invalidInput", message, data: null };
      };
    }, message);
    await run.click();
    await expect(alert).toHaveText(message);
    await expect(workspace.getByRole("grid")).toHaveCount(0);
    await expect(run).toBeEnabled();
  }
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(4);
});

test("restores the SQL, sources and driver on reopen within each project", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  await selectSources(page, workspace);
  const driver = workspace.getByRole("button", { name: "Workspace DuckDB driver" });
  await driver.click();
  await page.getByRole("option", { name: "DuckDB Local" }).click();
  const editor = workspace.getByLabel("Workspace SQL");
  const sql = "SELECT * FROM #left.public.customers a JOIN #right.events.purchases b ON a.id = b.customer_id";
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(sql);

  const close = page
    .getByRole("region", { name: "Editor", exact: true })
    .getByRole("button", { name: "Close Tab", exact: true });
  await close.click();
  await expect(workspace).toHaveCount(0);
  await openWorkspace(page);
  await expect(editor).toHaveText(sql);
  await expect(workspace.getByRole("button", { name: "Left data source" })).toHaveText("Accounts · PostgreSQL");
  await expect(workspace.getByRole("button", { name: "Right data source" })).toHaveText("Events · ClickHouse");
  await expect(driver).toHaveText("DuckDB Local");
  await expect(workspace.getByRole("grid")).toHaveCount(0);
  await close.click();

  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const project = useProject.getState().project;
    useProject.setState({ project: { ...project, root: project.root + "-other" } });
  });
  await openWorkspace(page);
  await expect(editor).not.toHaveText(sql);
  await expect(workspace.getByRole("button", { name: "Left data source" })).toHaveText("Select data source");
  await expect(driver).toHaveText("DuckDB JDBC");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);
});
