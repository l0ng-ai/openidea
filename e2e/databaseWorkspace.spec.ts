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

const SQL = "SELECT * FROM #left.public.customers a JOIN #right.events.purchases b ON a.id = b.customer_id";

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
    .getByRole("button", { name: "Configure Sources…" })
    .click();
  return page.getByRole("dialog", { name: "Configure Workspace Sources" });
}

async function selectSources(page: Page, settings: Locator) {
  await settings.getByRole("button", { name: "Left data source" }).click();
  await page.getByRole("option", { name: "Accounts · PostgreSQL" }).click();
  await settings.getByRole("button", { name: "Right data source" }).click();
  await expect(page.getByRole("option", { name: "Accounts · PostgreSQL" })).toHaveCount(0);
  await page.getByRole("option", { name: "Events · ClickHouse" }).click();
}

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
  await expect(workspace.locator("pre")).toContainText("FROM #accounts.public.customers");
  await expect(workspace.getByRole("button", { name: "Insert JOIN" })).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: "New Data Source…" })).toBeVisible();
  await expect(workspace.locator("pre")).toContainText("ON a.id = b.customer_id");
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
  const settings = page.getByRole("dialog", { name: "Configure Workspace Sources" });
  await expect(settings.getByText("Save two PostgreSQL or ClickHouse data sources first.")).toBeVisible();
  await expect(settings.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
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
  await setupWorkspace(page);
  const node = await showDatabase(page);
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Configure Sources…" }).click();
  const workspace = page.getByRole("region", { name: "Query Workspace" });
  const settings = page.getByRole("dialog", { name: "Configure Workspace Sources" });
  await selectSources(page, settings);
  await expect(settings.getByText("In memory", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-settings.png"), animations: "disabled" });
  await settings.getByRole("textbox", { name: "Left SQL alias" }).fill("  acct  ");
  const rightAlias = settings.getByRole("textbox", { name: "Right SQL alias" });
  await rightAlias.fill("acct");
  await expect(settings.getByRole("alert")).toHaveText(
    "Choose a unique SQL alias. The names left and right are reserved.",
  );
  const ok = settings.getByRole("button", { name: "OK", exact: true });
  await expect(ok).toBeDisabled();
  await rightAlias.fill("events");
  await expect(ok).toBeEnabled();
  await page.screenshot({ path: info.outputPath("workspace-aliases.png"), animations: "disabled" });
  await ok.click();
  const editor = workspace.getByLabel("Workspace SQL");
  await expect(editor).toBeFocused();
  const context = workspace.getByRole("button", {
    name: /Configure Sources.*Accounts.*PostgreSQL.*Events.*ClickHouse.*DuckDB JDBC/,
  });
  await expect(context).toHaveText("acct ↔ events");
  await workspace.getByRole("button", { name: "Insert JOIN" }).click();
  const left = "#acct";
  await expect(editor).toContainText(left + ".public.customers");
  await expect(editor).toContainText("#events.events.purchases");
  const selection = () => page.evaluate(() => window.getSelection()?.toString());
  expect(await selection()).toBe("public");
  await editor.press("Tab");
  expect(await selection()).toBe("customers");
  await editor.press("Escape");

  await editor.press("Meta+A");
  await page.keyboard.insertText('SELECT * FROM #"Accounts · PostgreSQL".');
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /public\.customers/ })).toBeVisible();
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

test("runs the selected JOIN or the one at the caret from a multi-statement draft", async ({
  workbench: page,
}, info) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const settings = await settingsFor(page, workspace);
  await selectSources(page, settings);
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  const editor = workspace.getByLabel("Workspace SQL");
  const second = SQL.replace("public.customers", "legacy.customers");
  await editor.click();
  await page.keyboard.insertText(SQL + ";\n" + second + ";");
  await editor.press("Meta+Enter");
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(1);
  expect((await ipcCalls(page, "db_workspace_join"))[0]).toMatchObject({ left: { schema: "legacy" } });

  await editor.press("Meta+Home");
  await editor.press("Shift+End");
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toBe(SQL + ";");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(2);
  expect((await ipcCalls(page, "db_workspace_join"))[1]).toMatchObject({ left: { schema: "public" } });

  await page.evaluate(() => {
    const reply = window.__ipc.handlers.db_workspace_join;
    window.__ipc.handlers.db_workspace_join = async (args) => {
      await new Promise<void>((resolve) => {
        window.addEventListener("workspace-test-release", () => resolve(), { once: true });
      });
      const result = reply?.(args) as { rows: string[][] };
      if ((args.left as { schema: string }).schema === "legacy") result.rows[0]![1] = "Legacy customer";
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
  expect(calls.slice(2)).toMatchObject([{ left: { schema: "public" } }, { left: { schema: "legacy" } }]);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(0);

  await editor.press("Meta+A");
  await editor.press("Backspace");
  await workspace.getByRole("button", { name: "Insert JOIN" }).click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("public");
  await editor.press("Meta+Enter");
  await expect.poll(async () => (await ipcCalls(page, "db_workspace_join")).length).toBe(5);
  expect((await ipcCalls(page, "db_workspace_join"))[4]).toMatchObject({ left: { table: "customers" } });
  await release();
});

test("cancels the active request and surfaces parser, source and limit errors", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const settings = await settingsFor(page, workspace);
  await selectSources(page, settings);
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  const run = workspace.getByRole("button", { name: "Run", exact: true });
  const alert = workspace.getByRole("alert");
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText("DELETE FROM #left.public.customers");
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
  await expect(workspace.getByRole("button", { name: "Configure Sources…" })).toBeDisabled();
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
  const settings = await settingsFor(page, workspace);
  await selectSources(page, settings);
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  const editor = workspace.getByLabel("Workspace SQL");
  const alert = workspace.getByRole("alert");
  await editor.click();
  await page.keyboard.insertText(SQL + ";\nDELETE FROM #left.public.customers;");
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
    const settings = await settingsFor(page, workspace);
    await selectSources(page, settings);
    await settings.getByRole("button", { name: "OK", exact: true }).click();
    const editor = workspace.getByLabel("Workspace SQL");
    await editor.click();
    await page.keyboard.insertText([SQL, SQL.replace("public.customers", "legacy.customers"), SQL].join(";\n") + ";");
    await page.evaluate((failure) => {
      const reply = window.__ipc.handlers.db_workspace_join;
      window.__ipc.handlers.db_workspace_join = ({ request, left, ...args }) => {
        const result = reply?.({ request, left, ...args }) as { rows: Array<Array<string | null>> };
        if ((left as { schema: string }).schema !== "legacy") return result;
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

test("restores the SQL, sources and driver on reopen within each project", async ({ workbench: page }) => {
  await setupWorkspace(page);
  const workspace = await openWorkspace(page);
  const settings = await settingsFor(page, workspace);
  await selectSources(page, settings);
  const leftAlias = settings.getByRole("textbox", { name: "Left SQL alias" });
  const rightAlias = settings.getByRole("textbox", { name: "Right SQL alias" });
  await leftAlias.fill("acct");
  await rightAlias.fill("events");
  const driver = settings.getByRole("button", { name: "Workspace DuckDB driver" });
  await driver.click();
  await page.getByRole("option", { name: "DuckDB Local" }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  const editor = workspace.getByLabel("Workspace SQL");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText(SQL);

  const close = page
    .getByRole("region", { name: "Editor", exact: true })
    .getByRole("button", { name: "Close Tab", exact: true });
  await close.click();
  await expect(workspace).toHaveCount(0);
  await openWorkspace(page);
  await expect(editor).toHaveText(SQL);
  await settingsFor(page, workspace);
  await expect(settings.getByRole("button", { name: "Left data source" })).toHaveText("Accounts · PostgreSQL");
  await expect(settings.getByRole("button", { name: "Right data source" })).toHaveText("Events · ClickHouse");
  await expect(driver).toHaveText("DuckDB Local");
  await expect(leftAlias).toHaveValue("acct");
  await expect(rightAlias).toHaveValue("events");
  await settings.getByRole("button", { name: "Swap Sides" }).click();
  await expect(leftAlias).toHaveValue("events");
  await expect(rightAlias).toHaveValue("acct");
  await leftAlias.fill("discarded");
  await expect(settings.getByRole("button", { name: "Left data source" })).toHaveText("Events · ClickHouse");
  await expect(settings.getByRole("button", { name: "Right data source" })).toHaveText("Accounts · PostgreSQL");
  await driver.click();
  await page.getByRole("option", { name: "DuckDB JDBC" }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveText(SQL);
  await settingsFor(page, workspace);
  await expect(driver).toHaveText("DuckDB Local");
  await expect(leftAlias).toHaveValue("acct");
  await expect(rightAlias).toHaveValue("events");
  await expect(settings.getByRole("button", { name: "Left data source" })).toHaveText("Accounts · PostgreSQL");
  await expect(settings.getByRole("button", { name: "Right data source" })).toHaveText("Events · ClickHouse");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(async () => {
    const store = "/src/features/database/store.ts";
    const { useDatabase } = await import(/* @vite-ignore */ store);
    useDatabase.setState({ sources: [{ id: "events", name: "Events · ClickHouse", driver: "clickhouse" }] });
  });
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText("A saved workspace source is unavailable.");
  await expect(settings.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveText(SQL);
  await expect(workspace.getByRole("grid")).toHaveCount(0);
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
  await expect(settings.getByRole("button", { name: "Left data source" })).toHaveText("Select data source");
  await expect(driver).toHaveText("DuckDB JDBC");
  expect(await ipcCalls(page, "db_workspace_join")).toHaveLength(0);
});
