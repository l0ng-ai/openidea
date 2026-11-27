import type { Locator, Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function setupWorkspace(page: Page, options: { multipleDrivers?: boolean; fullNames?: boolean } = {}) {
  await stubDesktop(page);
  await page.evaluate(async ({ fullNames, multipleDrivers }) => {
    const store = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ store);
    const sources = [
      { id: "accounts", name: fullNames ? "Accounts · PostgreSQL" : "accounts", driver: "postgres" },
      { id: "events", name: fullNames ? "Events · ClickHouse" : "events", driver: "clickhouse" },
    ];
    const table = (schema: string, name: string, ...keys: string[]) => ({
      schema,
      name,
      kind: "table",
      columns: keys.map((name) => ({
        name,
        dataType: "BIGINT",
        nullable: false,
        primaryKey: false,
        hasDefault: false,
      })),
    });
    const completion = {
      accounts: {
        defaultSchema: "public",
        tables: [
          table("public", "customers", "id", "join_key"),
          table("legacy", "customers", "archived_id"),
          { ...table("public", "customers_view"), kind: "view" },
        ],
        foreignKeys: [],
      },
      events: {
        defaultSchema: "events",
        tables: [table("events", "purchases", "customer_id", "join_key")],
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
        ]
          .slice(0, multipleDrivers ? 2 : 1)
          .map((driver) => ({
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
  }, options);
}

async function openWorkspace(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("db.queryWorkspace");
  });
  return page.getByRole("region", { name: "Query Workspace" });
}

const SQL = "SELECT * FROM #accounts.public.customers a JOIN #events.events.purchases b ON a.id = b.customer_id";

async function saveWorkspaceDraft(page: Page, draft: Record<string, unknown>) {
  await page.evaluate(async (draft) => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const root = useProject.getState().project.root;
    localStorage.setItem("openidea.db-workspace:" + root, JSON.stringify(draft));
  }, draft);
}

async function showDatabase(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("db.showToolWindow");
  });
  return page.getByRole("tree", { name: "Data sources" }).getByRole("treeitem", { name: "Query Workspace" });
}

async function settingsFor(page: Page, workspace: Locator) {
  await workspace
    .getByRole("toolbar", { name: "Workspace actions" })
    .getByRole("button", { name: /Workspace Settings…/ })
    .click();
  return page.getByRole("dialog", { name: "Workspace Settings" });
}

test("joins four saved data sources without registering them in the workspace", async ({ workbench: page }, info) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const module = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ module);
    const sources = [
      { id: "accounts", name: "accounts", driver: "postgres" },
      { id: "events", name: "events", driver: "clickhouse" },
      { id: "warehouse", name: "warehouse", driver: "jdbc", vendor: "duckdb", url: "jdbc:duckdb:/warehouse.duckdb" },
      { id: "lookup", name: "lookup", driver: "sqlite", file: "lookup.sqlite" },
      { id: "memory", name: "memory", driver: "jdbc", vendor: "duckdb", url: "jdbc:duckdb:memory:session" },
      { id: "arbitrary", name: "arbitrary", driver: "jdbc", url: "jdbc:other:anywhere" },
      { id: "startup", name: "startup", driver: "postgres", options: { startupScript: "SELECT 1" } },
    ];
    useDatabase.setState({ sources, loaded: true });
    window.__ipc.handlers.db_sources = () => sources;
    const reply = window.__ipc.handlers.db_workspace_join;
    window.__ipc.handlers.db_workspace_join = (args) => ({
      ...(reply?.(args) as object),
      columns: [
        { name: "id", typeName: "BIGINT" },
        { name: "label", typeName: "VARCHAR" },
      ],
      rows: [
        ["9007199254740993", "Retail"],
        ["9007199254740994", "Wholesale"],
      ],
    });
  });
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.focus();
  await page.screenshot({ path: info.outputPath("workspace-four-source-empty.png"), animations: "disabled" });
  expect(await ipcCalls(page, "db_completion")).toHaveLength(0);
  await page.keyboard.insertText("SELECT * FROM ");
  await page.keyboard.insertText("#");
  for (const name of ["accounts", "events", "warehouse", "lookup"]) {
    await expect(page.getByRole("option", { name: new RegExp(`^#${name}`) })).toBeVisible();
  }
  await expect(page.getByRole("option", { name: /^#(memory|arbitrary|startup)/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("workspace-four-source-completion.png"), animations: "disabled" });
  expect(await ipcCalls(page, "db_completion")).toHaveLength(0);
  await editor.press("Escape");
  await editor.press("Meta+A");
  await page.keyboard.insertText(
    [
      "SELECT a.id, l.label FROM #accounts.public.customers AS a",
      "JOIN #events.events.purchases AS e ON a.id=e.customer_id",
      "JOIN #warehouse.main.items AS w ON e.customer_id=w.id",
      "JOIN #lookup.main.labels AS l ON l.id=w.id;",
    ].join("\n"),
  );
  await editor.press("Meta+Enter");
  await expect(workspace.getByRole("tab", { name: "Result 1", exact: true })).toBeVisible();
  await expect(workspace.getByRole("dialog", { name: "Workspace Settings" })).toHaveCount(0);
  await expect(workspace.getByRole("grid").getByText("Retail", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-four-source-results.png"), animations: "disabled" });
  expect(await ipcCalls(page, "db_workspace_join")).toMatchObject([
    {
      driver: "duck",
      plan: {
        tables: [
          { sourceId: "accounts", schema: "public", table: "customers" },
          { sourceId: "events", schema: "events", table: "purchases" },
          { sourceId: "warehouse", schema: "main", table: "items" },
          { sourceId: "lookup", schema: "main", table: "labels" },
        ],
        joins: [
          { left: { relation: 0, column: "id" }, rightColumn: "customer_id" },
          { left: { relation: 1, column: "customer_id" }, rightColumn: "id" },
          { left: { relation: 2, column: "id" }, rightColumn: "id" },
        ],
        projection: [
          { relation: 0, column: "id" },
          { relation: 3, column: "label" },
        ],
      },
    },
  ]);
  expect(await ipcCalls(page, "db_completion")).toHaveLength(0);
});

test("shows the workspace before any data sources are added", async ({ workbench: page }, info) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const store = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ store);
    window.__ipc.handlers.db_sources = () => [];
    useDatabase.setState({ sources: [], loaded: true });
  });
  const node = await showDatabase(page);
  await expect(node).toBeVisible();
  await node.click();
  await page.keyboard.press("Enter");
  const workspace = page.getByRole("region", { name: "Query Workspace" });
  const editor = workspace.getByLabel("Workspace SQL");
  await expect(editor).toBeEmpty();
  await expect(editor).toBeFocused();
  await expect(workspace.locator("pre")).toContainText("FROM #source_a.schema.table_a");
  await expect(workspace.getByRole("button", { name: "Insert JOIN" })).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: "New Data Source…" })).toBeVisible();
  await expect(workspace.locator("pre")).toContainText("ON a.key = b.key");
  await expect(workspace.getByRole("grid")).toHaveCount(0);
  const height = await editor.evaluate((element) => element.closest(".cm-editor")!.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(500);
  await page.screenshot({ path: info.outputPath("workspace-empty.png"), animations: "disabled" });
  await page.keyboard.insertText("SELECT");
  await expect(editor).toHaveText("SELECT");
  await expect(workspace.locator("pre")).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 620 });
  await page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: { ...settings, appearance: { ...settings?.appearance, theme: "dark", syncWithOs: false } },
    });
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await editor.press("Meta+Enter");
  const settings = page.getByRole("dialog", { name: "Workspace Settings" });
  await expect(
    settings.getByText("Save at least two PostgreSQL, ClickHouse, SQLite, or file-backed DuckDB sources."),
  ).toBeVisible();
  const dialog = (await settings.boundingBox())!;
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(720);
  await settings.getByRole("button", { name: "New Data Source…" }).click();
  const sourceDialog = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await expect(sourceDialog).toBeVisible();
  await sourceDialog.press("Escape");
  await settings.press("Escape");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);
});

test("completes preferred aliases and pages the same workspace result", async ({ workbench: page }, info) => {
  await setupWorkspace(page, { fullNames: true });
  const node = await showDatabase(page);
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Workspace Settings…/ }).click();
  const workspace = page.getByRole("region", { name: "Query Workspace" });
  const settings = page.getByRole("dialog", { name: "Workspace Settings" });
  await expect(settings.getByText("In memory", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-settings.png"), animations: "disabled" });
  await settings.getByRole("button", { name: "SQL aliases", exact: true }).press("Enter");
  await settings.getByRole("textbox", { name: /^SQL alias for Accounts/ }).fill("  acct  ");
  const rightAlias = settings.getByRole("textbox", { name: /^SQL alias for Events/ });
  await rightAlias.fill("acct");
  await expect(settings.getByRole("alert")).toHaveText("Choose a SQL alias unique to this source.");
  const ok = settings.getByRole("button", { name: "OK", exact: true });
  await expect(ok).toBeDisabled();
  await rightAlias.fill("events");
  await expect(ok).toBeEnabled();
  await page.screenshot({ path: info.outputPath("workspace-aliases.png"), animations: "disabled" });
  await ok.click();
  const editor = workspace.getByLabel("Workspace SQL");
  await expect(editor).toBeFocused();
  const context = workspace.getByRole("button", {
    name: /Workspace Settings.*DuckDB JDBC/,
  });
  await expect(context).toHaveText("DuckDB JDBC");
  await workspace.getByRole("button", { name: "Insert JOIN" }).click();
  await expect(editor).toContainText("#source_a.schema.table_a");
  await expect(editor).toContainText("#source_b.schema.table_b");
  const selection = () => page.evaluate(() => window.getSelection()?.toString());
  expect(await selection()).toBe("#source_a");
  await page.getByRole("option", { name: /^#acct/ }).click();
  await expect(editor).toContainText("#acct.schema.table_a");
  await editor.press("Tab");
  expect(await selection()).toBe("#source_b");
  await editor.press("Control+Space");
  await page.getByRole("option", { name: /^#events/ }).click();
  await editor.press("Tab");
  expect(await selection()).toBe("schema.table_a");
  await editor.press("Control+Space");
  await page.getByRole("option", { name: /^public\.customers/ }).click();
  await expect(editor).toContainText("#acct.public.customers");
  await editor.press("Tab");
  expect(await selection()).toBe("schema.table_b");

  await editor.press("Meta+A");
  await page.keyboard.insertText('SELECT * FROM #"Accounts · PostgreSQL".');
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /public\.customers/ })).toBeVisible();
  await editor.press("Escape");

  await editor.press("Meta+A");
  await page.keyboard.insertText("SELECT * FROM #ACCT.");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /^#ACCT\.public\.customers/ })).toBeVisible();
  await editor.press("Escape");

  await editor.press("Meta+A");
  await page.keyboard.insertText("SELECT *\nFROM #");
  await editor.press("Control+Space");
  await expect(
    page.getByRole("option", { name: /^#events/ }).getByText("Events · ClickHouse", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: /^#left/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /^#right/ })).toHaveCount(0);
  const accountOption = page.getByRole("option", { name: /^#acct/ });
  await expect(accountOption.getByText("Accounts · PostgreSQL", { exact: true })).toBeVisible();
  await accountOption.click();
  await page.keyboard.insertText(".");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /legacy\.customers/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /customers_view/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("workspace-completion.png"), animations: "disabled" });
  await page.getByRole("option", { name: /public\.customers/ }).click();
  await page.keyboard.insertText(" AS a\nJOIN #events.events.");
  await editor.press("Control+Space");
  await page.getByRole("option", { name: /#events\.events\.purchases/ }).click();
  await page.keyboard.insertText(" AS b\n  ON a.");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /archived_id|customer_id/ })).toHaveCount(0);
  const keyOption = (name: string) => page.getByRole("option").filter({ has: page.getByText(name, { exact: true }) });
  await expect(keyOption("id")).toBeVisible();
  await keyOption("id").click();
  await page.keyboard.insertText(" = b.");
  await editor.press("Control+Space");
  await expect(keyOption("customer_id")).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-keys.png"), animations: "disabled" });
  await keyOption("customer_id").click();
  await editor.press("Meta+Enter");

  const grid = workspace.getByRole("grid");
  await expect(grid.getByText("Customer 1", { exact: true })).toBeVisible();
  await expect(grid.getByText("9007199254740993", { exact: true })).toHaveCount(2);
  await expect(grid.getByText("123456789012345678.000001", { exact: true }).first()).toBeVisible();
  await expect(grid.getByText("<null>", { exact: true })).toBeVisible();
  expect((await ipcCalls(page, "db_workspace_join"))[0]).toMatchObject({
    driver: "duck",
    plan: {
      tables: [
        { sourceId: "accounts", database: "", schema: "public", table: "customers" },
        { sourceId: "events", database: "", schema: "events", table: "purchases" },
      ],
      joins: [{ left: { relation: 0, column: "id" }, rightColumn: "customer_id" }],
      projection: null,
    },
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

test("runs the selected JOIN or the one at the caret from a multi-statement draft", async ({
  workbench: page,
}, info) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  const second = SQL.replace("public.customers", "legacy.customers");
  await editor.click();
  await page.keyboard.insertText(SQL + ";\n" + second + ";");
  await editor.press("Meta+Enter");
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(1);
  expect((await ipcCalls(page, "db_workspace_join"))[0]).toMatchObject({
    plan: { tables: [{ schema: "legacy" }, { sourceId: "events" }] },
  });

  await editor.press("Meta+Home");
  await editor.press("Shift+End");
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toBe(SQL + ";");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(2);
  expect((await ipcCalls(page, "db_workspace_join"))[1]).toMatchObject({
    plan: { tables: [{ schema: "public" }, { sourceId: "events" }] },
  });

  await page.evaluate(() => {
    const reply = window.__ipc.handlers.db_workspace_join;
    window.__ipc.handlers.db_workspace_join = async (args) => {
      await new Promise<void>((resolve) => {
        window.addEventListener("workspace-test-release", () => resolve(), { once: true });
      });
      const result = reply?.(args) as { rows: string[][] };
      if ((args.plan as { tables: { schema: string }[] }).tables[0]!.schema === "legacy")
        result.rows[0]![1] = "Legacy customer";
      return result;
    };
  });
  const release = () => page.evaluate(() => window.dispatchEvent(new Event("workspace-test-release")));
  const selectionRange = () =>
    editor.evaluate((element) => {
      const state = (element as HTMLElement & { cmTile: { view: import("@codemirror/view").EditorView } }).cmTile.view
        .state;
      const { from, to } = state.selection.main;
      return { from, to };
    });
  await editor.press("Meta+A");
  const fullRange = await selectionRange();
  await editor.press("Meta+Enter");
  const running = workspace.locator(".cm-openidea-db-executing");
  const runningText = () => running.evaluateAll((nodes) => nodes.map((node) => node.textContent).join(""));
  await expect.poll(runningText).toBe(SQL);
  expect(await selectionRange()).toEqual(fullRange);
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("workspace-batch-running.png"), animations: "disabled" });
  await release();
  await expect.poll(runningText).toBe(second);
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(4);
  await release();
  await expect(workspace.getByRole("tab", { name: "Result 2", exact: true })).toBeVisible();
  await expect(workspace.locator(".cm-openidea-db-run-ok")).toHaveCount(2);
  const grid = workspace.getByRole("grid");
  await expect(grid.getByText("Legacy customer", { exact: true })).toBeVisible();
  await workspace.getByRole("tab", { name: "Result 1", exact: true }).click();
  await expect(grid.getByText("Customer 1", { exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "Next Page" }).click();
  await expect(grid.getByText("Last customer", { exact: true })).toBeVisible();
  await workspace.getByRole("tab", { name: "Result 2", exact: true }).click();
  await expect(grid.getByText("Legacy customer", { exact: true })).toBeVisible();
  await workspace.getByRole("tab", { name: "Result 1", exact: true }).click();
  await expect(grid.getByText("Last customer", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-batch-results.png"), animations: "disabled" });
  const calls = await ipcCalls(page, "db_workspace_join");
  expect(calls.slice(2)).toMatchObject([
    { plan: { tables: [{ schema: "public" }, { sourceId: "events" }] } },
    { plan: { tables: [{ schema: "legacy" }, { sourceId: "events" }] } },
  ]);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(0);

  await editor.press("Meta+A");
  await editor.press("Backspace");
  await workspace.getByRole("button", { name: "Insert JOIN" }).click();
  await page.getByRole("option", { name: /^#accounts/ }).click();
  await editor.press("Tab");
  await editor.press("Control+Space");
  await page.getByRole("option", { name: /^#events/ }).click();
  for (const field of ["public.customers", "events.purchases", "id", "customer_id"]) {
    await editor.press("Tab");
    await page.keyboard.insertText(field);
  }
  await editor.press("Meta+Enter");
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(5);
  expect((await ipcCalls(page, "db_workspace_join"))[4]).toMatchObject({
    plan: { tables: [{ table: "customers" }, { sourceId: "events" }] },
  });
  await release();
});

test("cancels the active request and surfaces parser, source and limit errors", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const run = workspace.getByRole("button", { name: "Run", exact: true });
  const alert = workspace.getByRole("alert");
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText("DELETE FROM #accounts.public.customers");
  await run.click();
  await expect(alert).toHaveText("Expected SELECT in the workspace query.");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);

  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(SQL);
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
  await expect(workspace.getByRole("button", { name: /Workspace Settings…/ })).toBeDisabled();
  await workspace.getByRole("button", { name: "Stop", exact: true }).click();
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

test("validates all selected statements before reading either source", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  const alert = workspace.getByRole("alert");
  await editor.click();
  await page.keyboard.insertText(SQL + ";\nDELETE FROM #accounts.public.customers;");
  await editor.press("Meta+A");
  await editor.press("Meta+Enter");
  await expect(alert).toHaveText("Expected SELECT in the workspace query.");
  await expect(workspace.locator(".cm-openidea-db-run-error")).toHaveCount(1);
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);

  await page.keyboard.insertText(Array.from({ length: 13 }, () => SQL + ";").join("\n"));
  await workspace.getByRole("button", { name: "Execute Script" }).click();
  await expect(alert).toHaveText("The workspace can run up to 12 statements at a time.");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);
});

for (const failure of ["cancel", "error", "row budget"] as const) {
  test(`stops the script after ${failure} and keeps the completed result`, async ({ workbench: page }) => {
    await setupWorkspace(page);
    const workspace = await openWorkspace(page);
    const editor = workspace.getByLabel("Workspace SQL");
    await editor.click();
    await page.keyboard.insertText([SQL, SQL.replace("public.customers", "legacy.customers"), SQL].join(";\n") + ";");
    await page.evaluate((failure) => {
      const reply = window.__ipc.handlers.db_workspace_join;
      window.__ipc.handlers.db_workspace_join = ({ request, plan, ...args }) => {
        const result = reply?.({ request, plan, ...args }) as { rows: Array<Array<string | null>> };
        if ((plan as { tables: { schema: string }[] }).tables[0]!.schema !== "legacy") return result;
        if (failure === "error") throw { kind: "invalidInput", message: "Could not connect to Events", data: null };
        if (failure === "row budget") return { ...result, rows: Array(100_000).fill(result.rows[0]) };
        return new Promise((_, reject) => {
          window.__ipc.handlers.cancel_request = ({ id }) => {
            if (id !== request) throw new Error("Unexpected cancellation request.");
            reject({ kind: "cancelled", message: "Operation cancelled", data: null });
          };
        });
      };
    }, failure);
    await workspace.getByRole("button", { name: "Execute Script" }).click();
    const result = workspace.getByRole("tab", { name: "Result 1", exact: true });
    await expect(result).toBeVisible();
    if (failure === "cancel") await workspace.getByRole("button", { name: "Stop", exact: true }).click();
    const message = {
      cancel: "Cancelled",
      error: "Could not connect to Events",
      "row budget": "The workspace batch exceeds the result size limit.",
    }[failure];
    await expect(workspace.getByRole("alert")).toHaveText(message);
    await expect(workspace.locator(".cm-openidea-db-run-ok")).toHaveCount(1);
    await expect(workspace.locator(".cm-openidea-db-run-error")).toHaveCount(1);
    await expect(workspace.locator(".cm-openidea-db-timing")).toHaveCount(2);
    await result.click();
    await expect(workspace.getByRole("grid").getByText("Customer 1", { exact: true })).toBeVisible();
    expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(2);
    expect(await ipcCalls(page, "db_execute")).toHaveLength(0);
  });
}

test("migrates old source slots, aliases and driver with each project's SQL", async ({ workbench: page }) => {
  await setupWorkspace(page, { multipleDrivers: true });
  const legacySQL = SQL.replace("#accounts", "#left").replace("#events", "#right");
  await saveWorkspaceDraft(page, {
    left: "accounts",
    right: "events",
    sourceAliases: { accounts: "acct", events: "evt" },
    profile: "duck-local",
    sql: legacySQL,
  });
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  await expect(editor).toHaveText(legacySQL);
  await editor.press("Meta+Enter");
  await expect(workspace.getByRole("tab", { name: "Result 1", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_workspace_join")).toMatchObject([
    { driver: "duck-local", plan: { tables: [{ sourceId: "accounts" }, { sourceId: "events" }] } },
  ]);

  const settings = await settingsFor(page, workspace);
  const driver = settings.getByRole("button", { name: "Workspace DuckDB driver" });
  await expect(driver).toHaveText("DuckDB Local");
  await settings.getByText("SQL aliases", { exact: true }).click();
  const accountsAlias = settings.getByRole("textbox", { name: /^SQL alias for accounts/ });
  const eventsAlias = settings.getByRole("textbox", { name: /^SQL alias for events/ });
  await expect(accountsAlias).toHaveValue("acct");
  await expect(eventsAlias).toHaveValue("evt");
  await accountsAlias.fill("customers");
  await settings.getByRole("button", { name: "OK", exact: true }).click();

  const close = page
    .getByRole("region", { name: "Editor", exact: true })
    .getByRole("button", { name: "Close Tab", exact: true });
  await close.click();
  await expect(workspace).toHaveCount(0);
  await openWorkspace(page);
  await expect(editor).toHaveText(legacySQL);
  await settingsFor(page, workspace);
  await settings.getByText("SQL aliases", { exact: true }).click();
  await expect(accountsAlias).toHaveValue("customers");
  await expect(eventsAlias).toHaveValue("evt");
  await expect(driver).toHaveText("DuckDB Local");
  await accountsAlias.fill("discarded");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await settingsFor(page, workspace);
  await settings.getByText("SQL aliases", { exact: true }).click();
  await expect(accountsAlias).toHaveValue("customers");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await close.click();

  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const project = useProject.getState().project;
    useProject.setState({ project: { ...project, root: project.root + "-other" } });
  });
  await openWorkspace(page);
  await expect(editor).toBeEmpty();
  await settingsFor(page, workspace);
  await expect(driver).toHaveText("Select DuckDB driver");
  await settings.getByText("SQL aliases", { exact: true }).click();
  await expect(accountsAlias).toHaveValue("");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(1);
});

test("does not retarget a deleted legacy source to an unrelated source named left", async ({ workbench: page }) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const module = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ module);
    const sources = [
      { id: "replacement", name: "left", driver: "postgres" },
      { id: "events", name: "events", driver: "clickhouse" },
    ];
    useDatabase.setState({ sources, loaded: true });
    window.__ipc.handlers.db_sources = () => sources;
  });
  const sql = SQL.replace("#accounts", "#left").replace("#events", "#right");
  await saveWorkspaceDraft(page, { sql, left: "deleted", right: "events" });
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  const alert = workspace.getByRole("alert");
  await editor.press("Meta+Enter");
  await expect(alert).toHaveText("Data source left is unavailable. Type # to see available sources.");
  await editor.press("Meta+A");
  await page.keyboard.insertText(sql.replace("#left", '#"left"'));
  await editor.press("Meta+Enter");
  await expect(alert).toHaveText("Data source left is unavailable. Type # to see available sources.");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);

  await editor.press("Meta+A");
  await page.keyboard.insertText("SELECT * FROM #");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /^#"?left/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Set unique SQL aliases…" }).click();
  const settings = page.getByRole("dialog", { name: "Workspace Settings" });
  await settings.getByRole("textbox", { name: "SQL alias for left (PostgreSQL)" }).fill("replacement_src");
  await settings.getByRole("button", { name: "OK", exact: true }).click();

  await editor.press("Meta+A");
  await page.keyboard.insertText(sql.replace("#left", "#replacement_src"));
  await editor.press("Meta+Enter");
  await expect(workspace.getByRole("tab", { name: "Result 1", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_workspace_join")).toMatchObject([
    { plan: { tables: [{ sourceId: "replacement" }, { sourceId: "events" }] } },
  ]);
});

test("offers aliases when identical saved names cannot be resolved", async ({ workbench: page }) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const module = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ module);
    const sources = [
      { id: "accounts", name: "Shared", driver: "postgres", host: "accounts.example" },
      { id: "events", name: "Shared", driver: "clickhouse", host: "events.example" },
    ];
    useDatabase.setState({ sources, loaded: true });
    window.__ipc.handlers.db_sources = () => sources;
  });
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.focus();
  await page.keyboard.insertText("SELECT * FROM #");
  await editor.press("Control+Space");
  const aliasOption = page.getByRole("option", { name: "Set unique SQL aliases…" });
  await expect(aliasOption).toBeVisible();
  await expect(page.getByRole("option", { name: /^#"Shared"/ })).toHaveCount(0);
  await aliasOption.click();
  const settings = page.getByRole("dialog", { name: "Workspace Settings" });
  await expect(settings.getByText("accounts.example", { exact: true })).toBeVisible();
  await settings.getByRole("textbox", { name: "SQL alias for Shared (PostgreSQL)" }).fill("accounts");
  await settings.getByRole("textbox", { name: "SQL alias for Shared (ClickHouse)" }).fill("events");
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /^#accounts/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^#events/ })).toBeVisible();
  expect(await ipcCalls(page, "db_completion")).toHaveLength(0);
});

test("keeps unrelated queries executable when a stored alias becomes ambiguous", async ({ workbench: page }) => {
  await setupWorkspace(page);
  await page.evaluate(async () => {
    const module = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ module);
    const sources = [
      ...useDatabase.getState().sources,
      { id: "old", name: "old", driver: "postgres" },
      { id: "new", name: "colliding", driver: "postgres" },
    ];
    useDatabase.setState({ sources, loaded: true });
    window.__ipc.handlers.db_sources = () => sources;
  });
  await saveWorkspaceDraft(page, { sql: SQL, sourceAliases: { old: "colliding" } });
  const workspace = await openWorkspace(page);
  await workspace.getByLabel("Workspace SQL").press("Meta+Enter");
  await expect(workspace.getByRole("tab", { name: "Result 1", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(1);
  const settings = await settingsFor(page, workspace);
  await expect(settings.getByRole("alert")).toHaveText("Choose a SQL alias unique to this source.");
  await expect(settings.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
});

test("asks before replacing a missing explicitly selected execution driver", async ({ workbench: page }) => {
  await setupWorkspace(page);
  await saveWorkspaceDraft(page, { sql: SQL, profile: "missing" });
  const workspace = await openWorkspace(page);
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.press("Meta+Enter");
  const settings = page.getByRole("dialog", { name: "Workspace Settings" });
  await expect(settings.getByRole("alert")).toHaveText("The saved DuckDB driver is unavailable.");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);
  const driver = settings.getByRole("button", { name: "Workspace DuckDB driver" });
  await driver.click();
  await page.getByRole("option", { name: "DuckDB JDBC" }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await editor.press("Meta+Enter");
  await expect(workspace.getByRole("tab", { name: "Result 1", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_workspace_join")).toMatchObject([{ driver: "duck" }]);
});
