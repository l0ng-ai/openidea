import { expect, test } from "./fixtures";

test("plugin view groups keep their own tabs and disappear when no view applies", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendModule = "/src/features/plugins/backend.ts";
    const storeModule = "/src/features/plugins/store.ts";
    const { createMemoryPluginsBackend, setPluginsBackend } = await import(/* @vite-ignore */ backendModule);
    const { usePlugins } = await import(/* @vite-ignore */ storeModule);
    const base = createMemoryPluginsBackend();
    const template = (await base.list()).plugins[0];
    const plugins = ["test.views", "test.other"].map((id) => ({ ...template, id, status: "inactive" }));
    setPluginsBackend({
      ...base,
      renderView: async (_pluginId: string, id: string) => ({
        toolbar: [],
        body: { kind: "message", value: `${id} content` },
        status: null,
      }),
    });
    const view = (pluginId: string, id: string, title: string, when?: string, group?: string) => ({
      pluginId,
      point: "views",
      key: id,
      decl: { id, title, location: "right", when, group },
    });
    usePlugins.setState({
      plugins,
      ui: [
        view("test.views", "routes", "Framework", "plugin.test.views.ready", "framework"),
        view("test.views", "beans", "Beans", "plugin.test.views.beans", "framework"),
        view("test.views", "legacy", "Legacy"),
        view("test.other", "routes", "Other framework", undefined, "framework"),
      ],
    });
  });
  const group = page.locator('[data-stripe-button="plugin.test.views.group:framework"]');
  const other = page.locator('[data-stripe-button="plugin.test.other.group:framework"]');
  await expect(group).toHaveCount(0);
  await expect(other).toBeVisible();
  await expect(page.locator('[data-stripe-button="plugin.test.views.legacy"]')).toBeVisible();
  const context = async (ready: boolean, beans: boolean) =>
    page.evaluate(
      async ({ ready, beans }) => {
        const module = "/src/platform/context.ts";
        const { setContext } = await import(/* @vite-ignore */ module);
        setContext("plugin.test.views.ready", ready);
        setContext("plugin.test.views.beans", beans);
      },
      { ready, beans },
    );
  await context(true, true);
  await expect(group).toBeVisible();
  await group.click();
  const pane = page.locator('[data-toolwindow="plugin.test.views.group:framework"]');
  await expect(pane.getByRole("tab")).toHaveText(["Framework", "Beans"]);
  await expect(pane.getByText("routes content")).toBeVisible();
  await pane.getByRole("tab", { name: "Beans", exact: true }).click();
  await expect(pane.getByText("beans content")).toBeVisible();
  await context(true, false);
  await expect(pane.getByRole("tab", { name: "Beans", exact: true })).toHaveCount(0);
  await expect(pane.getByText("routes content")).toBeVisible();
  await context(false, false);
  await expect(group).toHaveCount(0);
  await expect(pane).toHaveCount(0);
  await expect(other).toBeVisible();
});
