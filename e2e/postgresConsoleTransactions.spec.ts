import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("PostgreSQL console toolbar commits only the console with pending changes", async ({ workbench: page }) => {
  const id = "pg-console-scope";
  const name = "PostgreSQL console fixture";
  const a = `/app-data/consoles/db/${id}/console.sql`;
  const b = `/app-data/consoles/db/${id}/console_1.sql`;
  await stubDesktop(page);
  await page.evaluate(
    async ({ id, name, a, b }) => {
      const storePath = "/src/features/database/store.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const { bindConsole, useDatabase } = await import(storePath);
      const { editorService } = await import(contributionsPath);
      const source = { id, name, driver: "postgres", database: "test", options: { transaction: "manual" } };
      const manual = new Set<string>();
      Object.assign(window.__ipc.handlers, {
        db_sources: () => [source],
        db_connected: () => [id],
        db_databases: () => ({ names: ["test"], current: "test" }),
        db_schemas: () => ["public"],
        db_completion: () => ({ defaultSchema: "public", tables: [], foreignKeys: [] }),
        db_statements: ({ text }: { text: string }) => [{ from: 0, to: text.length, text }],
        db_set_console_manual_commit: ({ console, manual: enabled }: { console: string; manual: boolean }) => {
          if (!enabled) {
            manual.delete(console);
            return false;
          }
          const initialized = !manual.has(console);
          manual.add(console);
          return initialized;
        },
        db_execute: ({ statements }: { statements: { text: string }[] }) =>
          statements.map((statement) => ({
            statement,
            result: { columns: [], rows: [], affected: 1, elapsedMs: 1, executionMs: 1, truncated: [] },
            error: null,
          })),
        db_finish_console_transaction: () => null,
        db_release_result: () => null,
        db_release_console: () => null,
      });
      useDatabase.setState({ sources: [source], loaded: true, connected: new Set([id]) });
      bindConsole(a, id);
      bindConsole(b, id);
      await editorService().openFile(b, { focus: true });
      await editorService().openFile(a, { focus: true });
    },
    { id, name, a, b },
  );

  const toolbar = page.getByRole("toolbar", { name: "Query Console", exact: true });
  const mode = toolbar.getByRole("button", { name: "Transaction mode" });
  const commit = toolbar.getByRole("button", { name: "Commit", exact: true });
  const run = (path: string) =>
    page.evaluate(async (path) => {
      const storePath = "/src/features/database/store.ts";
      const { executeConsole } = await import(storePath);
      const sql = "INSERT INTO t VALUES (1)";
      await executeConsole(path, sql, 0, sql.length);
    }, path);

  await expect(mode).toHaveText("Tx: Manual");
  await run(a);
  await expect(commit).toBeEnabled();

  await page.getByRole("tab", { name: `console_1 [${name}]`, exact: true }).click();
  await expect(commit).toBeDisabled();
  await mode.click();
  await page.getByRole("option", { name: "Tx: Auto" }).click();
  await expect(mode).toHaveText("Tx: Auto");
  await run(b);
  await expect
    .poll(async () =>
      (await ipcCalls(page, "db_execute")).map(({ console, consoleManual }) => [console, consoleManual]),
    )
    .toEqual([
      [a, true],
      [b, false],
    ]);

  await page.getByRole("tab", { name: `console [${name}]`, exact: true }).click();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(commit).toBeDisabled();
  await expect.poll(() => ipcCalls(page, "db_finish_console_transaction")).toEqual([{ id, console: a, commit: true }]);
});
