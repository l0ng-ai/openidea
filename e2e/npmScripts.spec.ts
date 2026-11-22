/** The npm tool window lists package.json scripts without run configurations and runs them. */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const PKG = JSON.stringify({ name: "acme-api", scripts: { dev: "vite", build: "vite build" } });

/** The root package.json has scripts; there are no run configurations. */
async function stubNpm(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (pkg) => {
    const h = window.__ipc.handlers;
    h.fs_read_text = (args) => (String(args.path).endsWith("/package.json") ? pkg : "");
    h.run_configs = () => [];
    h.run_start = (args) => {
      const config = args.config as { id: string; name: string };
      return { id: 8, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
    };
    const npmModule = "/src/features/run/npmScripts.ts";
    const { loadNpmScripts } = await import(/* @vite-ignore */ npmModule);
    await loadNpmScripts();
  }, PKG);
}

test("lists scripts without run configurations and runs one on double-click", async ({ workbench: page }) => {
  await stubNpm(page);
  await page.getByRole("button", { name: "npm", exact: true }).click();
  const tree = page.getByRole("tree", { name: "npm scripts" });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /^acme-api/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "dev" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "build" })).toBeVisible();
  await tree.getByRole("treeitem", { name: "dev" }).dblclick();
  const [started] = await ipcCalls(page, "run_start");
  expect(started).toMatchObject({ config: { args: ["run", "dev"], kind: "npm" } });
});

test("offers Run / Debug in a script's context menu", async ({ workbench: page }) => {
  await stubNpm(page);
  await page.getByRole("button", { name: "npm", exact: true }).click();
  const tree = page.getByRole("tree", { name: "npm scripts" });
  await tree.getByRole("treeitem", { name: "build" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Run '.*run build'/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Debug '.*run build'/ })).toBeVisible();
});
