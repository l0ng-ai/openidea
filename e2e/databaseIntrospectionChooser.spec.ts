import type { Page } from "@playwright/test";
import type { DataSource_Deserialize, DbSchemaSelection, DbVisibilityChange } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const databasePanel = (page: Page) => page.locator('section[aria-label="Database"]');

async function persistedSources(page: Page): Promise<DataSource_Deserialize[]> {
  return page.evaluate(() => window.__ipc.handlers.db_sources!({}) as DataSource_Deserialize[]);
}

async function openTree(page: Page, sources: DataSource_Deserialize[]) {
  await stubDesktop(page);
  await page.evaluate(async (sources) => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    const connected = new Set<string>();
    Object.assign(window.__ipc.handlers, {
      db_sources: () => sources,
      db_connected: () => [...connected],
      db_connect: ({ id }: { id: string }) => {
        connected.add(id);
        return null;
      },
      db_disconnect: () => null,
      db_databases: () => ({ names: ["reporting", "sandbox", "maintenance"], current: "reporting" }),
      db_schemas: ({ id }: { id: string }) =>
        id === "ch" ? ["demo", "events", "warehouse"] : ["public", "app_data", "scratch"],
      db_save_sources: ({ sources: next }: { sources: DataSource_Deserialize[] }) => {
        sources = next;
        return null;
      },
      db_save_source_visibility: ({
        id,
        available,
        change,
      }: {
        id: string;
        available: string[];
        change: DbVisibilityChange;
      }) => {
        const update = (before: string[], selection: DbSchemaSelection, exact = false) =>
          selection.all || (!exact && before.some((name) => /[*?]/.test(name)))
            ? before
            : [...before.filter((name) => !available.includes(name)), ...(selection.names ?? [])];
        sources = sources.map((source) => {
          if (id !== source.id) return source;
          const introspection: NonNullable<DataSource_Deserialize["introspection"]> = { ...source.introspection };
          const selection = change.selection;
          if (change.kind === "databaseSchemas") {
            const overrides: Record<string, DbSchemaSelection> = { ...introspection.schemasByDatabase };
            if (!selection) delete overrides[change.database];
            else
              overrides[change.database] = {
                all: selection.all,
                names: update(overrides[change.database]?.names ?? [], selection, true),
              };
            introspection.schemasByDatabase = overrides;
          } else if (change.kind === "databases") {
            introspection.allDatabases = selection?.all;
            if (selection) introspection.databases = update(introspection.databases ?? [], selection);
          } else {
            introspection.allSchemas = selection?.all;
            if (selection) introspection.schemas = update(introspection.schemas ?? [], selection);
          }
          return { ...source, introspection };
        });
        return null;
      },
    });
    useDatabase.setState({ sources, loaded: true, connected: new Set(), schemas: {}, databases: {} });
    toolWindowService().show("database", true);
  }, sources);
  return databasePanel(page);
}

test("the localized chooser keeps source and database names verbatim", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const localePath = "/src/platform/i18n.ts";
    await (await import(/* @vite-ignore */ localePath)).setLocale("zh");
  });
  await openTree(page, [{ id: "ch", name: "Apply", driver: "clickhouse" }]);
  await page.evaluate(() => {
    window.__ipc.handlers.db_schemas = () => ["Retry"];
  });
  await page.getByRole("button", { name: "选择 Apply 的数据库", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择 Apply 的数据库", exact: true });
  await expect(dialog.getByRole("checkbox", { name: "Retry", exact: true })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "应用", exact: true })).toBeVisible();
});

test("a flat ClickHouse count applies a selection and cancels unsaved changes", async ({ workbench: page }, info) => {
  const panel = await openTree(page, [{ id: "ch", name: "ClickHouse Demo", driver: "clickhouse" }]);
  const source = panel.getByRole("treeitem").filter({ hasText: "ClickHouse Demo" });
  await source.locator("[data-tree-toggle]").click();
  await expect(panel.getByText("warehouse", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("clickhouse-tree.png"), animations: "disabled" });

  const count = source.getByRole("button", { name: "Choose databases for ClickHouse Demo" });
  await expect(count).toHaveText("3 of 3");
  await count.focus();
  await count.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose databases for ClickHouse Demo" });
  const search = dialog.getByRole("textbox", { name: "Filter names" });
  await expect(search).toBeFocused();
  await page.screenshot({ path: info.outputPath("clickhouse-chooser.png"), animations: "disabled" });
  await search.fill("ware");
  await expect(dialog.getByRole("checkbox", { name: "demo", exact: true })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "warehouse", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(count).toHaveText("2 of 3");
  await expect(panel.getByText("warehouse", { exact: true })).toHaveCount(0);
  expect(await ipcCalls(page, "db_schemas")).toHaveLength(1);
  expect(await persistedSources(page)).toMatchObject([
    { id: "ch", introspection: { allSchemas: false, schemas: ["demo", "events"] } },
  ]);

  await count.click();
  await search.fill("");
  await dialog.getByRole("checkbox", { name: "demo", exact: true }).uncheck();
  await count.click();
  await expect(dialog.getByRole("checkbox", { name: "demo", exact: true })).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(count).toBeFocused();
  await count.click();
  await dialog.getByRole("checkbox", { name: "events", exact: true }).uncheck();
  await page.locator("body").click({ position: { x: 450, y: 425 } });
  await expect(dialog).toHaveCount(0);
  await expect(count).toHaveText("1 of 3");
  expect(await ipcCalls(page, "db_save_source_visibility")).toHaveLength(2);

  await count.click();
  await dialog.getByRole("checkbox", { name: "demo", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(count).toHaveText("0 of 3");
  await expect(panel.getByText("demo", { exact: true })).toHaveCount(0);
});

test("a PostgreSQL database picker loads that database and overrides the source defaults", async ({
  workbench: page,
}, info) => {
  const panel = await openTree(page, [
    {
      id: "pg",
      name: "PostgreSQL Demo",
      driver: "postgres",
      introspection: { allSchemas: false, schemas: ["app_*"], objectFilter: "order*" },
    },
  ]);
  const source = panel.getByRole("treeitem").filter({ hasText: "PostgreSQL Demo" });
  await source.locator("[data-tree-toggle]").click();
  const reporting = panel.getByRole("treeitem").filter({ hasText: "reporting" });
  await expect(reporting).toBeVisible();
  expect(await ipcCalls(page, "db_schemas")).toHaveLength(0);
  const count = reporting.getByRole("button", { name: "Choose schemas for reporting" });
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Choose schemas for reporting" });
  await expect(dialog.getByRole("checkbox", { name: "app_data", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "public", exact: true })).not.toBeChecked();
  await page.screenshot({ path: info.outputPath("postgres-schema-chooser.png"), animations: "disabled" });
  expect(await ipcCalls(page, "db_schemas")).toMatchObject([{ id: "pg" }]);
  await dialog.getByRole("checkbox", { name: "public", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await persistedSources(page)).toMatchObject([
    {
      id: "pg",
      introspection: {
        allSchemas: false,
        schemas: ["app_*"],
        objectFilter: "order*",
        schemasByDatabase: { reporting: { all: false, names: ["public", "app_data"] } },
      },
    },
  ]);

  const sandbox = panel
    .getByRole("treeitem")
    .filter({ hasText: "sandbox" })
    .getByRole("button", { name: "Choose schemas for sandbox" });
  await sandbox.click();
  const sibling = page.getByRole("dialog", { name: "Choose schemas for sandbox" });
  await expect(sibling.getByRole("checkbox", { name: "app_data", exact: true })).toBeChecked();
  await expect(sibling.getByRole("checkbox", { name: "public", exact: true })).not.toBeChecked();
  await sibling.getByRole("button", { name: "Cancel", exact: true }).click();
  await count.click();
  await dialog.getByRole("checkbox", { name: "Use source settings", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await persistedSources(page)).toMatchObject([
    { introspection: { schemas: ["app_*"], schemasByDatabase: {} } },
  ]);
});

test("a PostgreSQL source keeps the connected database while narrowing the catalog", async ({ workbench: page }) => {
  const panel = await openTree(page, [{ id: "pg", name: "PostgreSQL Demo", driver: "postgres" }]);
  const source = panel.getByRole("treeitem").filter({ hasText: "PostgreSQL Demo" });
  await source.locator("[data-tree-toggle]").click();
  const count = source.getByRole("button", { name: "Choose databases for PostgreSQL Demo" });
  await expect(count).toHaveText("3 of 3");
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Choose databases for PostgreSQL Demo" });
  const current = dialog.getByRole("checkbox", { name: "reporting Current database", exact: true });
  await expect(current).toBeChecked();
  await expect(current).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "All databases", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(count).toHaveText("1 of 3");
  await expect(panel.getByText("reporting", { exact: true })).toBeVisible();
  await expect(panel.getByText("sandbox", { exact: true })).toHaveCount(0);
  expect(await ipcCalls(page, "db_schemas")).toHaveLength(0);
});

test("the source picker keeps matching and currently unavailable wildcard rules", async ({ workbench: page }) => {
  const schemas = ["ev*", "unavailable_?"];
  const panel = await openTree(page, [
    { id: "ch", name: "ClickHouse Demo", driver: "clickhouse", introspection: { allSchemas: false, schemas } },
  ]);
  const count = panel.getByRole("button", { name: "Choose databases for ClickHouse Demo" });
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Choose databases for ClickHouse Demo" });
  const events = dialog.getByRole("checkbox", { name: "events", exact: true });
  await expect(events).toBeChecked();
  await expect(events).toBeDisabled();
  await expect(dialog).toHaveAccessibleDescription("Edit name patterns in Data Source Properties.");
  await dialog.getByRole("checkbox", { name: "All databases", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(count).toHaveText("3 of 3");
  expect(await persistedSources(page)).toMatchObject([{ introspection: { allSchemas: true, schemas } }]);
  await count.click();
  await dialog.getByRole("checkbox", { name: "All databases", exact: true }).uncheck();
  await expect(events).toBeChecked();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(count).toHaveText("1 of 3");
  expect(await persistedSources(page)).toMatchObject([{ introspection: { allSchemas: false, schemas } }]);
});

test("the picker keeps explicitly chosen names absent from the catalog", async ({ workbench: page }) => {
  const panel = await openTree(page, [
    {
      id: "ch",
      name: "ClickHouse Demo",
      driver: "clickhouse",
      introspection: { allSchemas: false, schemas: ["demo", "unavailable"] },
    },
  ]);
  const count = panel.getByRole("button", { name: "Choose databases for ClickHouse Demo" });
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Choose databases for ClickHouse Demo" });
  await dialog.getByRole("checkbox", { name: "events", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(count).toHaveText("2 of 3");
  expect(await persistedSources(page)).toMatchObject([
    { introspection: { allSchemas: false, schemas: expect.arrayContaining(["demo", "events", "unavailable"]) } },
  ]);
});

test("editing the Properties defaults preserves the per-database override", async ({ workbench: page }) => {
  const schemasByDatabase = { reporting: { all: false, names: ["finance"] } };
  const panel = await openTree(page, [
    {
      id: "pg",
      name: "PostgreSQL Demo",
      driver: "postgres",
      host: "example.invalid",
      introspection: { schemasByDatabase },
    },
  ]);
  await panel.getByRole("button", { name: "Data Source Properties…" }).click();
  const dialog = page.getByRole("dialog", { name: "Data Source: PostgreSQL Demo" });
  await dialog.getByRole("tab", { name: "Schemas", exact: true }).click();
  await dialog.locator("#db-object-filter").fill("order*");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const [save] = await ipcCalls(page, "db_save_sources");
  expect(save).toMatchObject({ sources: [{ introspection: { schemasByDatabase, objectFilter: "order*" } }] });
});

test("an older remote server refuses the picker save without falling back", async ({ workbench: page }) => {
  const panel = await openTree(page, [{ id: "pg", name: "PostgreSQL Demo", driver: "postgres" }]);
  const count = panel.getByRole("button", { name: "Choose databases for PostgreSQL Demo" });
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Choose databases for PostgreSQL Demo" });
  await dialog.getByRole("checkbox", { name: "sandbox", exact: true }).uncheck();
  await page.evaluate(async () => {
    const remotePath = "/src/platform/remote.ts";
    const { enableRemote } = await import(remotePath);
    window.__ipc.handlers.remote_invoke = () => {
      throw { kind: "protocol", message: "command db_save_source_visibility is not available remotely", data: null };
    };
    enableRemote({
      target: { kind: "ssh", config: "synthetic" },
      root: "/project",
      host: "test.invalid",
      os: "linux",
      commands: ["db_save_source_visibility"],
    });
  });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Update the remote OpenIDEA server to edit visibility from the tree.",
  );
  expect(await ipcCalls(page, "remote_invoke")).toMatchObject([{ cmd: "db_save_source_visibility" }]);
  expect(await ipcCalls(page, "db_save_sources")).toHaveLength(0);
  expect(await ipcCalls(page, "db_disconnect")).toHaveLength(0);
  await expect(count).toHaveText("3 of 3");
});
