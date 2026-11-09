import { expect, stubDesktop, test } from "./fixtures";

test("plugin markers render names and package SVG variants and keep the indexed target chooser", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const pluginsPath = "/src/features/plugins/backend.ts";
    const storePath = "/src/features/plugins/store.ts";
    const projectionPath = "/src/features/plugins/projection.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    const { pluginsBackend, setPluginsBackend } = await import(pluginsPath);
    const { usePlugins } = await import(storePath);
    const { syncUiContributions } = await import(projectionPath);
    const source = "/dev/acme-api/markers.txt";
    const files = docBackend().files;
    files.set(source, "run marker\nbuiltin marker\npackage marker\n😀 mapping key\n");
    files.set("/dev/acme-api/target-a.txt", "first target\n");
    files.set("/dev/acme-api/target-b.txt", "second target\n");
    const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 5 } };
    window.__ipc.handlers.plugin_line_markers = () => [
      { pluginId: "hello", line: 0, icon: "run", tooltip: "Run marker", target: null },
      { pluginId: "hello", line: 1, icon: "database", tooltip: "Database marker", target: null },
      { pluginId: "hello", line: 2, icon: "icons/resource.svg", tooltip: "Package marker", target: null },
    ];
    window.__ipc.handlers.plugin_navigation_markers = () => [
      {
        path: source,
        version: 0,
        markers: [
          {
            range: { start: { line: 3, col: 3 }, end: { line: 3, col: 10 } },
            targets: ["target-a.txt", "target-b.txt"].map((name) => ({ path: `/dev/acme-api/${name}`, range })),
          },
        ],
      },
    ];
    window.__ipc.handlers.fs_read_text = (args) => files.get(String(args.path)) ?? "";
    window.__ipc.handlers.fs_probe = () => ({ size: 64, binary: false, tooLarge: false });
    window.__ipc.handlers.window_is_fullscreen = () => false;
    const base = pluginsBackend();
    setPluginsBackend({
      ...base,
      assets: async () => [
        [
          "markerIcon/resource/light",
          '<svg viewBox="0 0 16 16"><rect width="12" height="12" x="2" y="2" fill="#087faa"/></svg>',
        ],
        ["markerIcon/resource/dark", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#5bd1e8"/></svg>'],
      ],
    });
    const { ui, plugins } = usePlugins.getState();
    syncUiContributions(
      [
        ...ui,
        {
          pluginId: "hello",
          point: "markerIcons",
          key: "resource",
          decl: { id: "resource", icon: "icons/resource.svg" },
        },
      ],
      plugins,
    );
    await editorService().openFile(source);
  });
  const markers = page.locator(".cm-openidea-gutter-pluginMarkers");
  await expect(markers.locator('[title="Run marker"] svg')).toHaveAttribute("data-icon", "gutter-run");
  await expect(markers.locator('[title="Database marker"] svg')).toHaveAttribute("data-icon", "database");
  const custom = markers.locator('[title="Package marker"] svg');
  await expect(custom).toHaveAttribute("data-icon", /^ext:pluginIcon\/hello\//);
  await page.evaluate(async () => {
    const path = "/src/workbench/theme.ts";
    await (await import(path)).setTheme("dark");
  });
  await expect(custom.locator("circle")).toBeVisible();
  await expect(custom.locator("rect")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("markers-dark.png"), animations: "disabled" });
  await page.evaluate(async () => {
    const path = "/src/workbench/theme.ts";
    await (await import(path)).setTheme("light");
  });
  await expect(custom.locator("rect")).toBeVisible();
  await expect(custom.locator("circle")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("markers-light.png"), animations: "disabled" });
  await page.locator(".cm-plugin-mapping-gutter button").click();
  const chooser = page.getByRole("dialog", { name: "Choose Mapping Target" });
  await expect(chooser.getByRole("option")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("markers-chooser.png"), animations: "disabled" });
  await chooser.getByRole("option").filter({ hasText: "target-a.txt" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/workbench/contributions.ts";
        return (await import(path)).editorService().activePath();
      }),
    )
    .toBe("/dev/acme-api/target-a.txt");
});
