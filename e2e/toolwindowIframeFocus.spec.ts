/** Focus activation for tool windows with hidden inputs (docked Agents) and sandboxed plugin webview iframes. */
import { expect, test } from "./fixtures";

const TASK = {
  id: "task-1",
  title: "Inspect rollout logs",
  status: "ready" as const,
  isolation: "local" as const,
  provider: "codex",
  model: null,
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 1,
  updatedMs: 2,
  config: [],
  commands: [],
  usage: null,
  queue: [],
};

test("focuses docked Agents tool window instead of getting stuck on its hidden file input", async ({
  workbench: page,
}) => {
  await page.getByRole("treeitem", { name: "App.tsx", exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "Editor for /dev/acme-api/App.tsx" })).toBeFocused();

  await page.evaluate(async (task) => {
    const agentsStorePath = "/src/features/agents/store.ts";
    const { useAgents, dockTask } = await import(/* @vite-ignore */ agentsStorePath);
    useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      entries: new Map([[task.id, [{ type: "user", text: "Check pods", attachments: [] }]]]),
      unread: new Set(),
      docked: null,
      homeOpen: false,
      sessionLocation: "toolWindow",
    });
    dockTask(task.id);
  }, TASK);

  const agents = page.locator('[data-toolwindow="agents"]');
  await expect(agents).toBeVisible();
  await expect(agents).toHaveAttribute("data-focus-active", "");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const storePath = "/src/workbench/toolwindows/store.ts";
        const { useToolWindowLayout } = await import(/* @vite-ignore */ storePath);
        return useToolWindowLayout.getState().focused;
      }),
    )
    .toBe("agents");
});

test("tracks focus and focus-scope highlighting when clicking into a sandboxed plugin webview iframe", async ({
  workbench: page,
}) => {
  await page.getByRole("treeitem", { name: "App.tsx", exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "Editor for /dev/acme-api/App.tsx" })).toBeFocused();

  await page.evaluate(async () => {
    const pluginsBackendPath = "/src/features/plugins/backend.ts";
    const pluginsStorePath = "/src/features/plugins/store.ts";
    const bridgeRawPath = "/src/features/plugins/views/frame-bridge.js?raw";
    const { createMemoryPluginsBackend, setPluginsBackend } = await import(/* @vite-ignore */ pluginsBackendPath);
    const { usePlugins } = await import(/* @vite-ignore */ pluginsStorePath);
    const { default: bridgeSource } = await import(/* @vite-ignore */ bridgeRawPath);
    const bridgeFn = bridgeSource.trim().replace(/;\s*$/, "");

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<script>(${bridgeFn})(null);</script>
</head>
<body>
  <button id="pod-api" type="button">acme-api-7f9b4</button>
</body>
</html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const base = createMemoryPluginsBackend();
    const template = (await base.list()).plugins[0]!;
    const plugin = { ...template, id: "demo.k8s", name: "Kubernetes", status: "active" as const };
    setPluginsBackend({
      ...base,
      webPageUrl: async (pluginId: string) => (pluginId === "demo.k8s" ? url : base.webPageUrl(pluginId, "v")),
    });
    usePlugins.setState({
      plugins: [plugin],
      ui: [
        {
          pluginId: "demo.k8s",
          point: "views",
          key: "kubernetes",
          decl: { id: "kubernetes", title: "Kubernetes", location: "right", web: "web/index.html", header: "default" },
        },
      ],
    });
  });

  // Put Project in Undock mode so clicking into the plugin iframe also verifies unpinned/undocked auto-hide.
  await page.evaluate(async () => {
    const storePath = "/src/workbench/toolwindows/store.ts";
    const { setToolWindowViewMode, focusToolWindow } = await import(/* @vite-ignore */ storePath);
    setToolWindowViewMode("project", "undock");
    focusToolWindow("project");
  });
  const project = page.getByRole("region", { name: "Project", exact: true });
  await expect(project).toBeVisible();

  const k8sStripe = page.locator('[data-stripe-button="plugin.demo.k8s.kubernetes"]');
  await expect(k8sStripe).toBeVisible();
  await k8sStripe.click();
  const k8sRegion = page.locator('[data-toolwindow="plugin.demo.k8s.kubernetes"]');
  await expect(k8sRegion).toBeVisible();

  await page.frameLocator('iframe[data-plugin-webview="demo.k8s"]').locator("#pod-api").click();

  await expect(k8sRegion).toHaveAttribute("data-focus-active", "");
  await expect(project).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const storePath = "/src/workbench/toolwindows/store.ts";
        const ctxPath = "/src/platform/context.ts";
        const { useToolWindowLayout } = await import(/* @vite-ignore */ storePath);
        const { getContext } = await import(/* @vite-ignore */ ctxPath);
        return {
          focused: useToolWindowLayout.getState().focused,
          toolWindowFocus: getContext().toolWindowFocus,
          activeToolWindow: getContext().activeToolWindow,
        };
      }),
    )
    .toEqual({
      focused: "plugin.demo.k8s.kubernetes",
      toolWindowFocus: true,
      activeToolWindow: "plugin.demo.k8s.kubernetes",
    });
});
