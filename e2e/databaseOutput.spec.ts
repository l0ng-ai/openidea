import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const alpha = "/dev/acme-api/inventory/console.sql";
const beta = "/dev/acme-api/retail/console.sql";
const empty = "/dev/acme-api/empty.sql";

test("follows the active SQL console and preserves the selected client when another query finishes", async ({
  workbench: page,
}, info) => {
  await stubDesktop(page);
  await page.evaluate(
    async ({ alpha, beta, empty }) => {
      let release: (() => void) | undefined;
      const projectPath = "/src/platform/project.ts";
      const storePath = "/src/features/database/store.ts";
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const { bindConsole, useDatabase } = await import(/* @vite-ignore */ storePath);
      useProject.setState({ settings: {} });
      useDatabase.setState({
        loaded: true,
        sources: [
          { id: "inventory", name: "Inventory SQLite", driver: "sqlite", readOnly: true },
          { id: "retail", name: "Retail SQLite", driver: "sqlite", readOnly: true },
        ],
        completion: {
          inventory: { defaultSchema: "main", tables: [], foreignKeys: [] },
          retail: { defaultSchema: "main", tables: [], foreignKeys: [] },
        },
      });
      bindConsole(alpha, "inventory");
      bindConsole(beta, "retail");
      bindConsole(empty, "inventory");
      Object.assign(window.__ipc.handlers, {
        settings_get: () => useProject.getState().settings,
        settings_get_global: () => useProject.getState().settings,
        settings_set: ({ value }: { value: string }) => ({
          database: { outputDestination: JSON.parse(value) },
        }),
        db_explain: () => [{ parent: null, operation: "Constant row", params: "", properties: [] }],
        db_connected: () => ["inventory", "retail"],
        db_statements: ({ text }: { text: string }) => [{ from: 0, to: text.length, text }],
        db_execute: async ({ statements }: { statements: Array<{ text: string }> }) => {
          const statement = statements[0]!;
          const text = statement.text;
          if (text.includes("Background failure")) {
            await new Promise<void>((resolve) => (release = resolve));
            return [{ statement, error: "Background failure", result: null }];
          }
          return [
            {
              statement,
              result: {
                columns: [{ name: "value", typeName: "text" }],
                rows: [[text.includes("Alpha") ? "Alpha row" : "Beta row"]],
                hasMore: false,
                elapsedMs: 2,
                executionMs: 1,
              },
              error: null,
            },
          ];
        },
        "test:finishDbRequest": () => release?.(),
      });
    },
    { alpha, beta, empty },
  );

  const open = async (path: string) =>
    page.evaluate(async (path) => {
      const contributionsPath = "/src/workbench/contributions.ts";
      const { editorService } = await import(/* @vite-ignore */ contributionsPath);
      await editorService().openFile(path, { focus: true });
    }, path);
  const run = async (path: string, sql: string) => {
    await open(path);
    const editor = page.locator(".cm-editor:visible .cm-content[contenteditable=true]");
    await editor.click();
    await editor.press("Meta+A");
    await page.keyboard.insertText(sql);
    await editor.press("Meta+Enter");
    await expect(editor).toBeFocused();
  };

  const panel = page.locator('section[aria-label="Database Output"]');
  await run(alpha, "select 'Alpha'");
  await expect(panel.getByRole("gridcell", { name: "Alpha row", exact: true })).toBeVisible();
  await run(beta, "select 'Beta'");
  await expect(panel.getByRole("gridcell", { name: "Beta row", exact: true })).toBeVisible();
  await open(alpha);
  await expect(panel.getByRole("gridcell", { name: "Alpha row", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("database-output-after.png"), animations: "disabled" });

  const client = panel.getByRole("button", { name: "SQL client", exact: true });
  await client.click();
  await expect(page.getByRole("option", { name: /console\.sql · Inventory SQLite/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /console\.sql · Retail SQLite/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("database-output-clients.png"), animations: "disabled" });
  await page.getByRole("option", { name: /console\.sql · Retail SQLite/ }).click();
  await expect(client).toHaveText("console.sql · Retail SQLite");
  await expect(panel.getByRole("gridcell", { name: "Beta row", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Open Client in Editor" }).click();
  const editor = page.locator(".cm-editor:visible .cm-content[contenteditable=true]");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("select 'Beta'");
  expect(await ipcCalls(page, "db_execute")).toHaveLength(2);

  await open(alpha);
  const retail = page.getByRole("option", { name: /console\.sql · Retail SQLite/ });
  await client.press("ArrowDown");
  await expect(retail).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(client).toHaveText("console.sql · Retail SQLite");

  await client.press("ArrowDown");
  await expect(retail).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(retail).toBeHidden();
  await expect(client).toHaveText("console.sql · Retail SQLite");

  await client.press("Escape");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("select 'Alpha'");
  await expect(client).toHaveText("console.sql · Retail SQLite");
  await expect(panel.getByRole("gridcell", { name: "Beta row", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "db_execute")).toHaveLength(2);
  await editor.press("Meta+A");
  await page.keyboard.insertText("select 'Alpha while inspecting Beta'");
  await editor.press("Meta+Enter");
  await expect(editor).toBeFocused();
  await expect(client).toHaveText("console.sql · Inventory SQLite");
  await expect(panel.getByRole("gridcell", { name: "Alpha row", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("database-output-foreground-after.png"), animations: "disabled" });

  await run(alpha, "select 'Background failure'");
  await expect.poll(async () => (await ipcCalls(page, "db_execute")).length).toBe(4);
  await client.click();
  await retail.click();
  await page.evaluate(() => window.__ipc.handlers["test:finishDbRequest"]?.({}));
  await expect
    .poll(() =>
      page.evaluate(async (path) => {
        const storePath = "/src/features/database/store.ts";
        const { useDatabase } = await import(/* @vite-ignore */ storePath);
        return Object.hasOwn(useDatabase.getState().executions, path);
      }, alpha),
    )
    .toBe(false);
  await expect(client).toHaveText("console.sql · Retail SQLite");
  await expect(panel.getByRole("gridcell", { name: "Beta row", exact: true })).toBeVisible();

  await client.click();
  await page.getByRole("option", { name: /console\.sql · Inventory SQLite/ }).click();
  await expect(panel.getByRole("log")).toContainText("Background failure");
  await expect(panel.getByRole("log")).not.toContainText("select 'Beta'");
  await open(empty);
  await expect(panel.getByRole("log")).toBeVisible();
  await expect(panel.getByRole("log")).not.toContainText("Background failure");
  await open(beta);
  await client.click();
  await page.getByRole("option", { name: /console\.sql · Inventory SQLite/ }).click();
  await expect(panel.getByRole("log")).toContainText("Background failure");
  await page.getByRole("button", { name: "Explain Plan", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "Query Plan" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("tree")).toContainText("Constant row");
  await expect(page.locator(".cm-editor:visible .cm-content[contenteditable=true]")).toBeFocused();
  await panel.getByRole("tab", { name: "Query Plan" }).focus();
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await expect(panel.getByRole("gridcell", { name: "Beta row", exact: true })).toBeVisible();

  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Show query results in");
  await settings.getByRole("treeitem", { name: "Database", exact: true }).click();
  const destination = settings.getByRole("button", { name: "Show query results in", exact: true });
  await expect(destination).toHaveText("Database Output");
  await destination.click();
  await page.getByRole("option", { name: "Services", exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  expect(await ipcCalls(page, "settings_set")).toContainEqual({
    scope: "global",
    key: "database.outputDestination",
    value: '"services"',
  });
  const services = page.locator('section[aria-label="Services"]');
  await expect(services).toBeVisible();
  await expect(services.getByRole("tab", { name: "Query Plan" })).toBeVisible();
  await expect(panel).not.toBeVisible();
  expect(await ipcCalls(page, "db_execute")).toHaveLength(4);
});
