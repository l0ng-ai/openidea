/**
 * npm 工具窗口（Maven 面板风格）：独立扫描项目 package.json（不依赖运行配置
 * 检测），按包分组列出 scripts，双击运行，右键 Run/Debug。配置在 IPC 层 stub。
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const PKG = JSON.stringify({ name: "acme-api", scripts: { dev: "vite", build: "vite build" } });

/** stub 桌面层：fs_read_text 读项目根的 package.json；run_configs 没有任何 npm 配置（独立验证）。 */
async function stubNpm(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (pkg) => {
    const h = window.__ipc.handlers;
    h.fs_read_text = (args: { path: string }) => (args.path.endsWith("/package.json") ? pkg : "");
    h.run_configs = () => [];
    h.run_start = (args: { config: { id: string; name: string } }) => ({
      id: 8,
      configId: args.config.id,
      name: args.config.name,
      pid: 4242,
      running: true,
      pty: false,
    });
    const npmModule = "/src/features/run/npmScripts.ts";
    const { loadNpmScripts } = await import(/* @vite-ignore */ npmModule);
    await loadNpmScripts();
  }, PKG);
}

test("npm 窗口独立于运行配置列出 scripts，双击运行", async ({ workbench: page }) => {
  await stubNpm(page);
  await page.getByRole("button", { name: "npm", exact: true }).click();
  const tree = page.getByRole("tree", { name: "npm scripts" });
  await expect(tree).toBeVisible();
  // 根包显示项目名；脚本列出（run_configs 为空也有数据：独立数据源）。
  await expect(tree.getByRole("treeitem", { name: /^acme-api/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "dev" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "build" })).toBeVisible();
  // 双击 dev：构建临时配置启动。
  await tree.getByRole("treeitem", { name: "dev" }).dblclick();
  const [started] = await ipcCalls(page, "run_start");
  expect(started).toMatchObject({ config: { args: ["run", "dev"], kind: "npm" } });
});

test("右键脚本提供 Run / Debug", async ({ workbench: page }) => {
  await stubNpm(page);
  await page.getByRole("button", { name: "npm", exact: true }).click();
  const tree = page.getByRole("tree", { name: "npm scripts" });
  await tree.getByRole("treeitem", { name: "build" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Run '.*run build'/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Debug '.*run build'/ })).toBeVisible();
});
