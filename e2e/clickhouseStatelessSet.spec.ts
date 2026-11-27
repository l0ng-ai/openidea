import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("a refused stateless SET gives a fix in the console and leaves it usable", async ({ workbench: page }) => {
  const path = "/app-data/consoles/db/fixture/console.sql";
  const help =
    "Standalone SET needs a ClickHouse HTTP session. Set use_http_session=true in Advanced or use query-level SETTINGS where applicable.";
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, help }) => {
      const storePath = "/src/features/database/store.ts";
      const editorPath = "/src/workbench/contributions.ts";
      const { useDatabase, bindConsole } = await import(/* @vite-ignore */ storePath);
      const { editorService } = await import(/* @vite-ignore */ editorPath);
      const sources = [
        {
          id: "fixture",
          name: "ClickHouse fixture",
          driver: "clickhouse",
          properties: [{ name: "use_http_session", value: "false" }],
        },
      ];
      const completion = { defaultSchema: "default", tables: [], foreignKeys: [] };
      useDatabase.setState({
        sources,
        loaded: true,
        connected: new Set(["fixture"]),
        completion: { fixture: completion },
      });
      Object.assign(window.__ipc.handlers, {
        db_sources: () => sources,
        db_connected: () => ["fixture"],
        db_completion: () => completion,
        db_statements: ({ text }: { text: string }) => {
          let offset = 0;
          return text.split(";").flatMap((part) => {
            const from = offset + part.length - part.trimStart().length;
            offset += part.length + 1;
            const sql = part.trim();
            return sql ? [{ from, to: from + sql.length, text: sql }] : [];
          });
        },
        db_execute_stream: ({
          statements,
          onProgress,
        }: {
          statements: Array<{ text: string }>;
          onProgress: unknown;
        }) => {
          const send = (event: unknown) => window.__ipc.send(onProgress, event);
          send({ type: "started", index: 0 });
          send({ type: "completed", index: 0, outcome: { statement: statements[0], result: null, error: help } });
          send({ type: "done", error: null });
          return null;
        },
        db_execute: ({ statements }: { statements: Array<{ text: string }> }) =>
          statements.map((statement) => ({
            statement,
            error: null,
            result: {
              statement: statement.text,
              columns: [{ name: "value", typeName: "String" }],
              rows: [["one-query"]],
              affected: null,
              hasMore: false,
              elapsedMs: 1,
              executionMs: 1,
              truncated: [],
            },
          })),
      });
      bindConsole(path, "fixture");
      await editorService().openFile(path, { focus: true });
    },
    { path, help },
  );
  const toolbar = page.getByRole("toolbar", { name: "Query Console", exact: true });
  const editor = page.locator(".cm-editor:visible .cm-content[contenteditable=true]");
  const write = async (sql: string) => {
    await editor.focus();
    await editor.press("Meta+A");
    await page.keyboard.insertText(sql);
  };
  await write("SET log_comment='openidea-test';\nSELECT getSetting('log_comment');");
  await toolbar.getByRole("button", { name: "Execute Script", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: help })).toBeVisible();
  await expect(page.locator(".cm-openidea-db-run-error")).toHaveCount(1);
  await expect(page.locator(".cm-openidea-db-run-ok")).toHaveCount(0);
  expect(await ipcCalls(page, "db_execute_stream")).toHaveLength(1);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(0);

  await write("SELECT getSetting('log_comment') LIMIT 1 SETTINGS log_comment='one-query'");
  await toolbar.getByRole("button", { name: "Execute Script", exact: true }).click();
  await expect(page.getByRole("gridcell", { name: "one-query", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: help })).toHaveCount(0);
  expect(await ipcCalls(page, "db_execute")).toHaveLength(1);
  expect(await ipcCalls(page, "db_execute_stream")).toHaveLength(1);
});
