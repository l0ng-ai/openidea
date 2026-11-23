import type { MavenModel } from "../src/platform/ipc";
import { expect, stubDesktop, test } from "./fixtures";

const maven: MavenModel = {
  projects: [
    {
      pom: "pom.xml",
      dir: "",
      groupId: "dev.acme",
      artifactId: "billing",
      version: "1.0.0",
      packaging: "jar",
      displayName: "Billing",
      parent: null,
      modules: [],
      aggregated: false,
      plugins: [
        {
          groupId: "org.apache.maven.plugins",
          artifactId: "maven-surefire-plugin",
          version: "3.2.5",
          prefix: "surefire",
          goals: ["test"],
        },
      ],
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
};

test("Maven plugin rows give the name priority over coordinates in narrow docks", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async (maven) => {
    window.__ipc.handlers.build_model = () => ({ maven, gradle: [] });
    const buildModule = "/src/features/build-tools/store.ts";
    const { loadModel, setExpanded } = await import(/* @vite-ignore */ buildModule);
    await loadModel();
    setExpanded("maven", new Set(["mvn:pom.xml", "mvn:pom.xml:plugins"]));
    const dockModule = "/src/workbench/toolwindows/store.ts";
    const { showToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ dockModule);
    showToolWindow("maven", true);
    setToolWindowSize("right", 190);
  }, maven);

  const tree = page.getByRole("tree", { name: "Maven projects" });
  const coordinates = "(org.apache.maven.plugins:maven-surefire-plugin:3.2.5)";
  const plugin = tree.getByRole("treeitem", { name: `surefire ${coordinates}`, exact: true });
  const name = plugin.getByText("surefire", { exact: true });
  const metadata = plugin.getByText(coordinates, { exact: true });
  await expect(name).toBeVisible();
  await expect(metadata).toHaveAttribute("title", coordinates);
  const fit = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width <= el.getBoundingClientRect().width;
  };
  expect(await name.evaluate(fit)).toBe(true);
  expect(await metadata.evaluate(fit)).toBe(false);
  expect(await metadata.evaluate((el) => getComputedStyle(el).color)).not.toBe(
    await name.evaluate((el) => getComputedStyle(el).color),
  );

  await plugin.locator("[data-tree-toggle]").click();
  await expect(tree.getByRole("treeitem", { name: "surefire:test", exact: true })).toBeVisible();
});
