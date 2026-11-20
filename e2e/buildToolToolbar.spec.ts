import type { Page } from "@playwright/test";
import type { BuildModel, BuildTool } from "../src/platform/ipc";
import { expect, stubDesktop, test } from "./fixtures";

const model: BuildModel = {
  maven: {
    projects: [
      {
        pom: "pom.xml",
        dir: "",
        groupId: "com.example",
        artifactId: "orders",
        version: "1.0.0",
        packaging: "jar",
        displayName: "Orders service",
        parent: null,
        modules: [],
        aggregated: false,
        plugins: [],
        dependencies: [],
        profiles: [],
        javaVersion: 21,
        command: "mvn",
        options: [],
        env: {},
      },
    ],
    profiles: [],
    syncedAt: 1,
    stale: false,
    syncError: null,
  },
  gradle: [
    {
      dir: "",
      command: "gradle",
      env: {},
      javaVersion: 21,
      syncedAt: 1,
      stale: false,
      syncError: null,
      projects: [{ path: ":", name: "orders", dir: "", buildFile: "build.gradle", tasks: [] }],
    },
  ],
};

async function showTool(page: Page, tool: BuildTool) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ tool, model }) => {
      window.__ipc.handlers.build_model = () => model;
      window.__ipc.handlers.run_configs = () => [];
      const buildStore = "/src/features/build-tools/store.ts";
      await (await import(/* @vite-ignore */ buildStore)).loadModel();
      const layout = "/src/workbench/toolwindows/store.ts";
      const { setToolWindowSize, showToolWindow } = await import(/* @vite-ignore */ layout);
      showToolWindow(tool, true);
      setToolWindowSize("right", 190);
    },
    { tool, model },
  );
}

async function setWidth(page: Page, width: number) {
  await page.evaluate(async (px) => {
    const layout = "/src/workbench/toolwindows/store.ts";
    (await import(/* @vite-ignore */ layout)).setToolWindowSize("right", px);
  }, width);
}

for (const tool of ["maven", "gradle"] as const) {
  const name = tool === "maven" ? "Maven" : "Gradle";
  test(`${name} keeps its toolbar actions reachable as the pane resizes`, async ({ workbench: page }) => {
    await showTool(page, tool);
    const toolbar = page.getByRole("toolbar", { name: `${name} actions` });
    const more = toolbar.getByRole("button", { name: "More Actions", exact: true });
    const menu = page.getByRole("menu", { name: "More Actions", exact: true });
    const skipTests = "Toggle 'Skip Tests' Mode";
    await expect(toolbar.getByRole("button", { name: `Reload All ${name} Projects` })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: new RegExp(`Execute ${name}`) })).toBeVisible();
    await expect(page.getByRole("tree", { name: `${name} projects` })).toBeVisible();
    expect(await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await more.click();
    await expect(menu.getByRole("menuitem", { name: "Analyze Dependencies…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Expand All" })).toBeVisible();
    await menu.getByRole("menuitemcheckbox", { name: skipTests, checked: false }).click();
    await expect(menu).toBeHidden();
    await more.click();
    await expect(menu.getByRole("menuitemcheckbox", { name: skipTests, checked: true })).toBeVisible();
    await setWidth(page, 360);
    await expect(menu).toBeHidden();
    await expect(more).toBeHidden();
    await expect(toolbar.getByRole("button", { name: skipTests, pressed: true })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Collapse All" })).toBeVisible();
    await setWidth(page, 190);
    await expect(more).toBeVisible();
    await expect(menu).toBeHidden();
  });
}
