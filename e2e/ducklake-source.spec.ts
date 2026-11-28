import type { DataSource_Deserialize } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("opens an existing DuckLake and creates a new one only after confirmation through mocked desktop IPC", async ({
  workbench: page,
}, info) => {
  const driverId = "duckdb-fixture";
  const catalogFile = "/demo/sales/catalog.ducklake";
  const dataPath = "/demo/sales/parquet";
  const newDirectory = "/demo/new-lake";
  await stubDesktop(page);
  await page.evaluate(
    async ({ driverId, newDirectory }) => {
      let sources: DataSource_Deserialize[] = [];
      Object.assign(window.__ipc.handlers, {
        db_sources: () => sources,
        db_connected: () => [],
        db_jdbc_drivers: () => [
          {
            id: driverId,
            vendor: "duckdb",
            name: "DuckDB JDBC",
            className: "org.duckdb.DuckDBDriver",
            jars: ["/mock/duckdb_jdbc.jar"],
            urlTemplate: "jdbc:duckdb:{file}",
          },
        ],
        file_dialog_needs_gtk: () => false,
        "plugin:dialog|save": () => newDirectory,
        db_test: () => "DuckDB 2.0.1 (mock)",
        db_approve_ducklake_source: () => null,
        db_set_password: () => null,
        db_save_sources: ({ sources: next }: { sources: DataSource_Deserialize[] }) => {
          sources = next;
          return null;
        },
        db_create_ducklake: () => null,
      });
      const path = "/src/features/database/store.ts";
      (await import(/* @vite-ignore */ path)).openSourceDialog(null);
    },
    { driverId, newDirectory },
  );

  const draft = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await draft.getByRole("button", { name: "Data source type", exact: true }).click();
  await page.getByRole("option", { name: "DuckDB", exact: true }).click();
  await expect(draft.getByRole("button", { name: "Connection driver" })).toHaveText("DuckDB JDBC");
  await draft.getByLabel("Name:", { exact: true }).fill("Sales Lake");
  await draft.getByRole("button", { name: "DuckLake", exact: true }).click();
  await draft.getByLabel("Catalog file:", { exact: true }).fill(catalogFile);
  await draft.getByLabel("Data directory:", { exact: true }).fill(dataPath);
  await expect(draft.locator("#db-url")).toHaveCount(0);
  await draft.getByRole("tab", { name: "Options", exact: true }).click();
  const readOnly = draft.getByRole("checkbox", { name: "Read-only", exact: true });
  await expect(readOnly).toBeChecked();
  await expect(readOnly).toBeDisabled();
  await draft.getByRole("tab", { name: "General", exact: true }).click();

  await draft.getByRole("button", { name: "Test Connection", exact: true }).click();
  await expect(draft.getByRole("status")).toHaveText("Succeeded: DuckDB 2.0.1 (mock)");
  const connection = {
    name: "Sales Lake",
    driver: "jdbc",
    vendor: "duckdb",
    jdbcDriver: driverId,
    url: "jdbc:duckdb:",
    readOnly: true,
    savePassword: false,
    properties: [],
    duckLake: { kind: "file", value: catalogFile, dataPath },
  };
  expect(await ipcCalls(page, "db_test")).toEqual([
    expect.objectContaining({ password: null, sshSecret: null, source: expect.objectContaining(connection) }),
  ]);
  expect(await ipcCalls(page, "db_create_ducklake")).toHaveLength(0);
  await draft.screenshot({ path: info.outputPath("ducklake-existing.png"), animations: "disabled" });
  await draft.getByRole("button", { name: "OK", exact: true }).click();
  await expect(draft).not.toBeVisible();
  expect(await ipcCalls(page, "db_approve_ducklake_source")).toEqual([{ source: expect.objectContaining(connection) }]);
  expect(await ipcCalls(page, "db_approve_jdbc_source")).toHaveLength(0);
  expect(await ipcCalls(page, "db_save_sources")).toEqual([{ sources: [expect.objectContaining(connection)] }]);

  await page.evaluate(async () => {
    const path = "/src/features/database/store.ts";
    const { openSourceDialog, useDatabase } = await import(/* @vite-ignore */ path);
    openSourceDialog(useDatabase.getState().sources[0]);
  });
  const reopened = page.getByRole("dialog", { name: "Data Source: Sales Lake", exact: true });
  const file = reopened.getByLabel("Catalog file:", { exact: true });
  await expect(file).toHaveValue(catalogFile);
  await expect(reopened.getByLabel("Data directory:", { exact: true })).toHaveValue(dataPath);
  const create = reopened.getByRole("button", { name: "Create New DuckLake…", exact: true });
  const confirmation = page.getByRole("dialog", { name: "Create New DuckLake", exact: true });
  await create.click();
  await expect(confirmation).toContainText(newDirectory);
  await expect(confirmation).toContainText("The directory must not already exist.");
  expect(await ipcCalls(page, "db_create_ducklake")).toHaveLength(0);
  await confirmation.screenshot({ path: info.outputPath("ducklake-create-confirmation.png"), animations: "disabled" });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(file).toHaveValue(catalogFile);
  expect(await ipcCalls(page, "db_create_ducklake")).toHaveLength(0);

  await create.click();
  await confirmation.getByRole("button", { name: "Create", exact: true }).click();
  await expect(reopened.getByRole("status")).toHaveText("DuckLake created. The data source opens it read-only.");
  await expect(file).toHaveValue(newDirectory + "/catalog.ducklake");
  await expect(reopened.getByLabel("Data directory:", { exact: true })).toHaveValue("");
  expect(await ipcCalls(page, "db_create_ducklake")).toEqual([{ jdbcDriver: driverId, directory: newDirectory }]);
  expect(await ipcCalls(page, "db_save_sources")).toHaveLength(1);
  expect(await ipcCalls(page, "db_test")).toHaveLength(1);
  await reopened.screenshot({ path: info.outputPath("ducklake-created.png"), animations: "disabled" });
});
