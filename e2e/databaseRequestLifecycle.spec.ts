import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

declare global {
  interface Window {
    __dbLifecycle: { release: (fail: boolean) => void; releaseSave?: () => void };
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
