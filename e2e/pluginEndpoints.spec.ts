import { doubleShift, expect, test } from "./fixtures";

test("plugin routes feed search, HTTP completion and the declaration gutter and disappear on removal", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const c = "/src/workbench/contributions.ts";
    const b = "/src/editor/core/backend.ts";
    const { registerEndpointProvider, editorService } = await import(c);
    const { docBackend } = await import(b);
    docBackend().files.set("/dev/acme-api/routes.txt", "route declaration\n");
    docBackend().files.set("/dev/acme-api/routes.http", "GET {{host}}/pe");
    (window as unknown as { removeRoutes: () => void }).removeRoutes = registerEndpointProvider({
      id: "plugin:routes:test",
      endpoints: async (root: string) =>
        root === "/dev/acme-api"
          ? [
              {
                method: "*",
                url: "/people/{id}",
                framework: "Rails",
                handler: "People#show",
                pluginId: "routes",
                controller: "Rails",
                methodName: "People#show",
                path: "/dev/acme-api/routes.txt",
                rel: "routes.txt",
                line: 0,
                col: 0,
              },
            ]
          : [],
    });
    await editorService().openFile("/dev/acme-api/routes.txt");
  });
  await expect(page.locator('.cm-openidea-gutter-endpoints button[title="Open in HTTP Client"]')).toBeVisible();
  await doubleShift(page);
  const search = page.getByRole("dialog", { name: "Search Everywhere" });
  await search.getByRole("combobox").fill("/people");
  await expect(search.getByRole("option", { name: /people/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    await (await import(path)).editorService().openFile("/dev/acme-api/routes.http");
  });
  const content = page.locator(".cm-content").last();
  await content.click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete").getByText("/people/{{id}}", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await doubleShift(page);
  await search.getByRole("combobox").fill("/people");
  await expect(search.getByRole("option", { name: /people/ })).toBeVisible();
  await page.evaluate(() => (window as unknown as { removeRoutes: () => void }).removeRoutes());
  await expect(search.getByRole("option", { name: /people/ })).toBeHidden();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    await (await import(path)).editorService().openFile("/dev/acme-api/routes.txt");
  });
  await expect(page.locator('.cm-openidea-gutter-endpoints button[title="Open in HTTP Client"]')).toBeHidden();
});
