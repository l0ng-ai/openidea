import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

declare global {
  interface Window {
    __dbLifecycle: { release: (fail: boolean) => void; releaseSave?: () => void };
    __releaseConsoleDeactivate?: () => void;
  }
}

async function setup(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    let sources = [{ id: "lifecycle", name: "Lifecycle database", driver: "sqlite", file: "/project/data.sqlite" }];
    let resolve!: (schemas: string[]) => void;
    let reject!: (reason: unknown) => void;
    const response = new Promise<string[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    window.__dbLifecycle = {
      release: (fail) => {
        if (fail) reject({ kind: "unavailable", message: "Old metadata failed" });
        else resolve(["old_schema"]);
      },
    };
    Object.assign(window.__ipc.handlers, {
      db_sources: () => sources,
      db_connected: () => [],
      db_connect: () => null,
      db_disconnect: () => null,
      db_schemas: () => response,
      db_save_sources: (args: { sources: typeof sources }) => {
        sources = args.sources;
        return null;
      },
    });
    useDatabase.setState({
      sources,
      loaded: true,
      connected: new Set(),
      schemas: {},
      tables: {},
      details: {},
      objects: {},
    });
    toolWindowService().show("database", true);
  });
  const panel = page.locator('section[aria-label="Database"]');
  const source = panel.getByRole("treeitem").filter({ hasText: "Lifecycle database" });
  await source.locator("[data-tree-toggle]").click();
  await expect.poll(async () => (await ipcCalls(page, "db_schemas")).length).toBe(1);
  await expect(panel.locator('[title="Connected"]')).toHaveCount(1);
  return { panel, source };
}

async function release(page: Page, fail = false) {
  await page.evaluate(async (fail) => {
    window.__dbLifecycle.release(fail);
    // Let the promise chain and the resulting React render finish.
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  }, fail);
}

for (const fail of [false, true]) {
  test(`deactivation ignores a delayed metadata ${fail ? "failure" : "success"}`, async ({ workbench: page }) => {
    const { panel, source } = await setup(page);
    await source.click();
    await panel.getByRole("button", { name: /^Deactivate/ }).click();
    await expect(panel.locator('[title="Connected"]')).toHaveCount(0);
    await release(page, fail);
    await expect(panel.locator('[title="Connected"]')).toHaveCount(0);
    await expect(panel.getByText("old_schema", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("Old metadata failed", { exact: true })).toHaveCount(0);
  });
}

test("deactivation keeps an open console idle until the user requests metadata", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, bindConsole } = await import(storePath);
    const { editorService, toolWindowService } = await import(contributionsPath);
    const id = "console-lifecycle";
    const path = "/app-data/consoles/db/console-lifecycle/console.sql";
    const source = {
      id,
      name: "Console database",
      driver: "postgres",
      database: "app",
      externalTunnel: { executable: "/opt/example/forwarder", arguments: ["{localPort}"] },
    };
    let firstSchemas = true;
    let finishSchemas!: (schemas: string[]) => void;
    const pendingSchemas = new Promise<string[]>((resolve) => {
      finishSchemas = resolve;
    });
    Object.assign(window.__ipc.handlers, {
      db_sources: () => [source],
      db_connected: () => [id],
      db_databases: () => ({ names: ["app"], current: "app" }),
      db_completion: () => ({ defaultSchema: "public", tables: [], foreignKeys: [] }),
      db_schemas: () => {
        if (!firstSchemas) return ["reporting"];
        firstSchemas = false;
        return pendingSchemas;
      },
      db_disconnect: () =>
        new Promise<void>((resolve) => {
          window.__releaseConsoleDeactivate = () => {
            resolve();
            finishSchemas(["old_schema"]);
          };
        }),
    });
    useDatabase.setState({ sources: [source], loaded: true, connected: new Set([id]), schemas: {}, databases: {} });
    toolWindowService().show("database", true);
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  });
  const panel = page.locator('section[aria-label="Database"]');
  const toolbar = page.getByRole("toolbar", { name: "Query Console", exact: true });
  await expect(toolbar).toBeVisible();
  await expect.poll(async () => (await ipcCalls(page, "db_schemas")).length).toBe(1);
  await expect.poll(async () => (await ipcCalls(page, "db_completion")).length).toBe(1);

  await panel.getByRole("treeitem").filter({ hasText: "Console database" }).click();
  await panel.getByRole("button", { name: /^Deactivate/ }).click();
  await expect.poll(() => ipcCalls(page, "db_disconnect")).toEqual([{ id: "console-lifecycle", wholeSource: true }]);
  await page.evaluate(async () => {
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    window.__releaseConsoleDeactivate!();
  });
  await expect(panel.locator('[title="Connected"]')).toHaveCount(0);
  await expect(toolbar).toBeVisible();
  expect(await ipcCalls(page, "db_schemas")).toHaveLength(1);
  expect(await ipcCalls(page, "db_databases")).toHaveLength(1);
  expect(await ipcCalls(page, "db_completion")).toHaveLength(1);

  const picker = toolbar.getByRole("button", { name: "Database and schema" });
  await picker.click();
  await page.getByRole("option", { name: "reporting", exact: true }).click();
  await expect(picker).toHaveText("app.reporting");
  await expect(panel.locator('[title="Connected"]')).toHaveCount(1);
});

test("deleting a data source ignores its delayed metadata", async ({ workbench: page }) => {
  const { panel } = await setup(page);
  await page.evaluate(async () => {
    const path = "/src/features/database/store.ts";
    const { deleteSource } = await import(path);
    await deleteSource("lifecycle");
  });
  await expect(panel.getByText("No data sources", { exact: true })).toBeVisible();
  await release(page);
  await expect(panel.getByText("No data sources", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/features/database/store.ts";
        const { useDatabase } = await import(path);
        return { connected: [...useDatabase.getState().connected], schemas: useDatabase.getState().schemas };
      }),
    )
    .toEqual({ connected: [], schemas: {} });
});

test("switching projects ignores the old source even when its ID is reused", async ({ workbench: page }) => {
  const { panel } = await setup(page);
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useProject } = await import(projectPath);
    const { loadSources } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    window.__ipc.handlers.db_sources = () => [{ id: "lifecycle", name: "New project database", driver: "sqlite" }];
    useProject.setState({ project: { ...useProject.getState().project, root: "/new-project", name: "New project" } });
    await loadSources();
    toolWindowService().show("database", true);
  });
  await expect(panel.getByText("New project database", { exact: true })).toBeVisible();
  await release(page);
  await expect(panel.locator('[title="Connected"]')).toHaveCount(0);
  await expect(panel.getByText("old_schema", { exact: true })).toHaveCount(0);
});

test("an old source save cannot close the new project's dialog", async ({ workbench: page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/features/database/store.ts";
    const { openSourceDialog, useDatabase } = await import(path);
    window.__ipc.handlers.db_save_sources = () =>
      new Promise<void>((resolve) => {
        window.__dbLifecycle.releaseSave = resolve;
      });
    openSourceDialog(useDatabase.getState().sources[0]);
  });
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "db_save_sources")).length).toBe(1);
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const projectPath = "/src/platform/project.ts";
    const { openDialog } = await import(storePath);
    const { useProject } = await import(projectPath);
    useProject.setState({ project: { ...useProject.getState().project, root: "/new-project", name: "New project" } });
    openDialog({ kind: "params", names: ["newParameter"], resolve: () => {} });
  });
  await expect(page.getByRole("dialog").getByText("newParameter", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.__dbLifecycle.releaseSave!();
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await expect(page.getByRole("dialog").getByText("newParameter", { exact: true })).toBeVisible();
});
