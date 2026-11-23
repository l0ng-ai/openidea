import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

/** Supply detected configurations without launching desktop processes. */
async function configure(page: Page, extra = 0) {
  await page.evaluate(async (extra) => {
    const storePath = "/src/features/run/store.ts";
    const projectPath = "/src/platform/project.ts";
    const { useRun } = await import(storePath);
    const { useProject } = await import(projectPath);
    localStorage.setItem(`openidea.services.runTypes:${useProject.getState().project.root}`, '["spring-boot","npm"]');
    useRun.setState({
      configs: [
        ["gateway", "spring-boot"],
        ["portal", "spring-boot"],
        ["web", "npm"],
        ["worker", "npm"],
        ...Array.from({ length: extra }, (_, i) => [`app-${i}`, "spring-boot"]),
      ].map(([id, kind]) => ({
        id,
        name: id,
        kind,
        command: kind,
        args: [],
        env: {},
        cwd: null,
        detected: true,
        isTest: false,
        debugAdapter: null,
      })),
    });
  }, extra);
  if (!(await page.getByRole("tree", { name: "Services", exact: true }).isVisible()))
    await page.keyboard.press("Meta+8");
  await expect(page.getByRole("tree", { name: "Services", exact: true })).toBeVisible();
}

async function move(page: Page, source: string, target: string) {
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  const sourceRow = tree.getByRole("treeitem", { name: source, exact: true });
  await sourceRow.click();
  const from = await sourceRow.boundingBox();
  const to = await tree.getByRole("treeitem", { name: target, exact: true }).boundingBox();
  if (!from || !to) throw new Error("Service row is not visible");
  await page.mouse.move(from.x + 70, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 70, to.y + 3, { steps: 8 });
  await page.mouse.up();
}

test("Services favors details and stacks the panes when docked to the side", async ({ workbench: page }) => {
  await configure(page);
  const services = page.getByRole("region", { name: "Services", exact: true });
  const items = services.locator("[data-panel][id=services-items]");
  const detail = services.locator("[data-panel][id=services-detail]");
  const handle = services.locator("[data-separator]");
  const share = async (axis: "width" | "height") => {
    const treeSize = (await items.boundingBox())![axis];
    return treeSize / (treeSize + (await detail.boundingBox())![axis]);
  };
  const dock = (anchor: "bottom" | "right" | "left") =>
    page.evaluate(async (anchor) => {
      const path = "/src/workbench/toolwindows/store.ts";
      const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ path);
      moveToolWindow("services", anchor);
      if (anchor !== "bottom") setToolWindowSize(anchor, 280);
    }, anchor);

  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => share("width")).toBeCloseTo(0.3, 2);
  await handle.press("ArrowRight");
  await expect.poll(() => share("width")).toBeGreaterThan(0.31);
  const bottom = await share("width");

  for (const anchor of ["right", "left"] as const) {
    await dock(anchor);
    await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
    const treeBox = (await items.boundingBox())!;
    const detailBox = (await detail.boundingBox())!;
    expect(detailBox.width).toBeCloseTo(treeBox.width, 0);
    expect(detailBox.y).toBeGreaterThanOrEqual(treeBox.y + treeBox.height - 1);
    await expect.poll(() => share("height")).toBeCloseTo(0.3, 2);
  }
  await handle.press("ArrowDown");
  await expect.poll(() => share("height")).toBeGreaterThan(0.31);
  const side = await share("height");

  await dock("bottom");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => share("width")).toBeCloseTo(bottom, 2);
  await dock("right");
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await expect.poll(() => share("height")).toBeCloseTo(side, 2);
});

test("service pointer ordering works for Java and npm and survives reload", async ({ workbench: page }) => {
  await configure(page);
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  await move(page, "portal", "gateway");
  await expect(tree.getByRole("treeitem")).toHaveText(["Spring Boot", "portal", "gateway", "npm", "web", "worker"]);
  await expect(tree.getByRole("treeitem", { name: "portal", exact: true })).toHaveAttribute("aria-selected", "true");
  await move(page, "worker", "web");
  await expect(tree.getByRole("treeitem")).toHaveText(["Spring Boot", "portal", "gateway", "npm", "worker", "web"]);
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await configure(page);
  await expect(tree.getByRole("treeitem")).toHaveText(["Spring Boot", "portal", "gateway", "npm", "worker", "web"]);
  await tree.getByRole("treeitem", { name: "web", exact: true }).click();
  await page.getByRole("button", { name: "Move Up", exact: true }).click();
  await expect(tree.getByRole("treeitem")).toHaveText(["Spring Boot", "portal", "gateway", "npm", "web", "worker"]);
});

test("service dragging scrolls across virtual rows without losing source identity", async ({ workbench: page }) => {
  await configure(page, 100);
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  const source = tree.getByRole("treeitem", { name: "portal", exact: true });
  await source.click();
  const from = await source.boundingBox();
  const bounds = await tree.boundingBox();
  if (!from || !bounds) throw new Error("Service rows are not visible");
  await page.mouse.move(from.x + 70, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + bounds.height - 5, { steps: 8 });
  await expect.poll(() => tree.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  const target = tree.getByRole("treeitem", { name: "app-99", exact: true });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error("Drop target is not visible");
  await page.mouse.move(to.x + 70, to.y + to.height - 3);
  await page.mouse.up();
  await expect(source).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith("openidea.services.runOrder:"));
        return key ? JSON.parse(localStorage.getItem(key)!)["spring-boot"].slice(-2) : [];
      }),
    )
    .toEqual(["app-99", "portal"]);
});

test("Docker Compose editor completes service references and navigates to declarations", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const backendModule = "/src/editor/core/backend.ts";
    const contribModule = "/src/workbench/contributions.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendModule);
    const { editorService } = await import(/* @vite-ignore */ contribModule);
    const compose = [
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "    networks:",
      "      - backend",
      "  redis:",
      "    image: redis:7",
      "  api:",
      "    build: .",
      "    depends_on:",
      "networks:",
      "  backend:",
      "    driver: bridge",
      "",
    ].join("\n");
    docBackend().files.set("/dev/acme-api/docker-compose.yml", compose);
    await editorService().openFile("/dev/acme-api/docker-compose.yml");
  });

  const editor = page.locator(".cm-editor");
  await expect(editor).toContainText("postgres:16");

  // Complete a service reference under `depends_on:`
  await editor.locator(".cm-line", { hasText: "depends_on:" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.press("Control+Space");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.getByText("postgres", { exact: true })).toBeVisible();
  await expect(popup.getByText("redis", { exact: true })).toBeVisible();
  await expect(popup.getByText("api", { exact: true })).toHaveCount(0);
  await page.keyboard.type("post");
  await expect(popup.getByText("redis", { exact: true })).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toHaveText("    - postgres");

  // Go to Declaration (⌘B) on `- postgres` jumps to `  postgres:` declaration
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  postgres:");

  // Go to Declaration (⌘B) on `- backend` jumps to `  backend:` under `networks:`
  await editor.locator(".cm-line", { hasText: "      - backend" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  backend:");
});

test("the Services detail pane adds no second scrollbar over a console", async ({ workbench: page }) => {
  // A short window: the run toolbar is taller than the detail pane, which used to make
  // the split panel scroll too (the console had its own scrollbar right beside it).
  await page.setViewportSize({ width: 1200, height: 640 });
  await page.evaluate(async () => {
    const store = await import(/* @vite-ignore */ "/src/features/run/store.ts" as string);
    await store.startSampleOutput(200, 50);
    const id = store.useRun.getState().activeSession as string;
    store.useRun.setState((s: { sessions: { id: string }[]; versions: Record<string, number> }) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status: "running" } : x)),
      versions: { ...s.versions, [id]: (s.versions[id] ?? 0) + 1 },
    }));
    const svc = await import(/* @vite-ignore */ "/src/features/run/services.tsx" as string);
    const tree = await import(/* @vite-ignore */ "/src/features/services/tree.ts" as string);
    const session = store.useRun.getState().sessions.find((s: { id: string }) => s.id === id);
    svc.addType(session.config.kind);
    tree.useServicesTree.setState({
      selectedKey: `run:config:${session.config.id}`,
      selectedKeys: new Set([`run:config:${session.config.id}`]),
    });
  });
  await page.keyboard.press("Meta+8");
  await expect(page.getByRole("log").first()).toBeVisible();
  const result = await page.evaluate(() => {
    const log = document.querySelector('[data-toolwindow="services"] [role="log"]');
    let panel: Element | null = log;
    while (panel && !panel.hasAttribute("data-panel")) panel = panel.parentElement;
    const inner = panel?.firstElementChild as HTMLElement | null;
    const scrollers: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-toolwindow="services"] *')) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight - el.clientHeight > 2)
        scrollers.push(String(el.className));
    }
    return { overflowY: inner ? getComputedStyle(inner).overflowY : "missing", scrollers };
  });
  // The panel's inner div carries the library's inline `overflow: auto`; the detail pane
  // overrides it, so the console is the only scroller.
  expect(result.overflowY).toBe("hidden");
  expect(result.scrollers.filter((c) => c.includes("detailPane") || c.includes("_panel_"))).toEqual([]);
  expect(result.scrollers.length).toBeGreaterThan(0);
});

test("Docker dashboard keeps multi-line container commands bounded and collapsible", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const script = Array.from({ length: 18 }, (_, i) => `  export STEP_${i}="/persist/slot-${i}"`).join("\n");
    const inspectJson = JSON.stringify([
      {
        Created: "2026-11-22T01:41:28Z",
        State: { Status: "running", Pid: 2048, StartedAt: "2026-11-22T01:41:29Z" },
        HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
        Config: {
          Entrypoint: ["/bin/bash", "-ec", `set -euo pipefail\n${script}\nexec /entrypoint.sh "$@"\n`, "--"],
          Cmd: ["./bin/Runner.Listener", "run", "--startuptype", "service"],
          WorkingDir: "/actions-runner",
          Env: [],
          Labels: {},
        },
        Mounts: [],
        NetworkSettings: { Ports: {}, Networks: {} },
      },
    ]);
    const containerId = "13de5573bf36a9c8d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3";
    const snapshot = {
      availability: { kind: "ready", clientVersion: "27.3.1", serverVersion: "27.3.1", context: null },
      executable: "/usr/local/bin/docker",
      containers: [
        {
          id: containerId,
          name: "runner-1",
          image: "myoung34/github-runner:latest",
          command: '"/bin/bash -ec \'set…"',
          state: "running",
          status: "Up 2 hours",
          ports: "",
          createdAt: "2026-11-22 01:41:28 +0000 UTC",
          composeProject: "selfhost",
          composeService: "github-runner",
          composeWorkingDir: "/Users/dev/selfhost",
          composeFiles: ["/Users/dev/selfhost/docker-compose.yml"],
        },
      ],
      images: [],
      volumes: [],
      networks: [],
      errors: [],
    };
    window.__ipc.handlers.docker_settings = () => ({
      connections: [{ id: "local", name: "Docker", endpoint: { kind: "default" } }],
      registries: [],
    });
    window.__ipc.handlers.docker_snapshot = () => snapshot;
    window.__ipc.handlers.docker_inspect = () => inspectJson;
    window.__ipc.handlers.docker_container_stats = () => ({
      cpuPerc: "1.20%",
      memUsage: "256MiB / 8GiB",
      memPerc: "3.12%",
      netIo: "1MB / 1MB",
      blockIo: "0B / 0B",
      pids: "12",
    });
    window.__ipc.handlers.docker_events = () => new Promise(() => {});
    window.__ipc.handlers.cancel_request = () => null;

    const storeModule = "/src/features/services/store.ts";
    const treeModule = "/src/features/services/tree.ts";
    const { useServices } = await import(/* @vite-ignore */ storeModule);
    const { useServicesTree } = await import(/* @vite-ignore */ treeModule);
    useServices.setState({
      settings: { connections: [{ id: "local", name: "Docker", endpoint: { kind: "default" } }], registries: [] },
      conns: { local: { snapshot, loading: false, error: null } },
      detailTab: "dashboard",
    });
    useServicesTree.setState({
      expanded: new Set(["docker:local", "docker:local:compose:selfhost"]),
      selectedKey: `docker:local:container:${containerId}`,
      selectedKeys: new Set([`docker:local:container:${containerId}`]),
    });
  });

  await page.keyboard.press("Meta+8");
  const services = page.getByRole("region", { name: "Services", exact: true });
  await expect(services.getByText("Container Overview")).toBeVisible();

  const toggle = services.getByRole("button", { name: /^\d+ lines$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  const preview = services.locator("code[data-no-tooltip]");
  await expect(preview).toContainText("↵");

  // Hovering the truncated command preview must not spawn a giant auto-ellipsis tooltip.
  await preview.hover();
  await page.waitForTimeout(700);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // Collapsed row stays strictly between Started and Working directory (no upward overlap).
  const startedLabel = services.getByText("Started", { exact: true });
  const commandLabel = services.getByText("Command", { exact: true });
  const workingDirLabel = services.getByText("Working directory", { exact: true });
  const collapsedStartedBox = (await startedLabel.boundingBox())!;
  const collapsedPreviewBox = (await preview.boundingBox())!;
  const collapsedWorkingBox = (await workingDirLabel.boundingBox())!;
  expect(collapsedPreviewBox.y).toBeGreaterThan(collapsedStartedBox.y + collapsedStartedBox.height);
  expect(collapsedWorkingBox.y).toBeGreaterThan(collapsedPreviewBox.y + collapsedPreviewBox.height);

  // Expanding reveals Entrypoint + Command arguments inside a bounded scroll box growing downward.
  await toggle.click();
  const collapseBtn = services.getByRole("button", { name: "Collapse", exact: true });
  await expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
  await expect(services.getByText("Entrypoint", { exact: true })).toBeVisible();
  await expect(services.getByText("Command arguments", { exact: true })).toBeVisible();

  const expandedStartedBox = (await startedLabel.boundingBox())!;
  const expandedCommandLabelBox = (await commandLabel.boundingBox())!;
  const entrypointPre = services.locator("pre").first();
  const scrollContainer = entrypointPre.locator("xpath=ancestor::div[1]/parent::div");
  const scrollBox = (await scrollContainer.boundingBox())!;
  const expandedWorkingBox = (await workingDirLabel.boundingBox())!;

  expect(expandedCommandLabelBox.y).toBeGreaterThan(expandedStartedBox.y + expandedStartedBox.height);
  expect(scrollBox.y).toBeGreaterThan(expandedCommandLabelBox.y);
  expect(scrollBox.height).toBeLessThanOrEqual(182);
  expect(expandedWorkingBox.y).toBeGreaterThanOrEqual(scrollBox.y + scrollBox.height - 1);

  await collapseBtn.click();
  await expect(services.getByRole("button", { name: /^\d+ lines$/ })).toHaveAttribute("aria-expanded", "false");
});

test("Docker Compose container Jump to Source opens the Compose file at the command or the service", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const composePath = "/dev/acme-api/docker-compose.yml";
    const composeYaml = [
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "  github-runner:",
      "    image: myoung34/github-runner:latest",
      "    entrypoint:",
      "      - /bin/bash",
      "      - -ec",
      "      - |",
      "        mkdir -p /persist/slots",
      '        exec /entrypoint.sh "$@"',
      '    command: ["./bin/Runner.Listener", "run", "--startuptype", "service"]',
      "",
    ].join("\n");

    const backendModule = "/src/editor/core/backend.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendModule);
    docBackend().files.set(composePath, composeYaml);
    window.__ipc.handlers.fs_read_text = ({ path }) => {
      if (path === composePath) return composeYaml;
      throw { kind: "notFound", message: `not found: ${String(path)}`, detail: null };
    };

    const runnerId = "13de5573bf36a9c8d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3";
    const dbId = "98ab76cd54ef3210fedcba9876543210abcdef0123456789abcdef0123456789";
    const snapshot = {
      availability: { kind: "ready", clientVersion: "27.3.1", serverVersion: "27.3.1", context: null },
      executable: "/usr/local/bin/docker",
      containers: [
        {
          id: runnerId,
          name: "selfhost-github-runner-1",
          image: "myoung34/github-runner:latest",
          command: '"/bin/bash -ec \'mkdir…"',
          state: "running",
          status: "Up 2 hours",
          ports: "",
          createdAt: "2026-11-22 01:41:28 +0000 UTC",
          composeProject: "selfhost",
          composeService: "github-runner",
          composeWorkingDir: "/dev/acme-api",
          composeFiles: [composePath],
        },
        {
          id: dbId,
          name: "selfhost-postgres-1",
          image: "postgres:16",
          command: "postgres",
          state: "running",
          status: "Up 2 hours",
          ports: "",
          createdAt: "2026-11-22 01:41:28 +0000 UTC",
          composeProject: "selfhost",
          composeService: "postgres",
          composeWorkingDir: "/dev/acme-api",
          composeFiles: [composePath],
        },
      ],
      images: [],
      volumes: [],
      networks: [],
      errors: [],
    };

    window.__ipc.handlers.docker_settings = () => ({
      connections: [{ id: "local", name: "Docker", endpoint: { kind: "default" } }],
      registries: [],
    });
    window.__ipc.handlers.docker_snapshot = () => snapshot;
    window.__ipc.handlers.docker_inspect = () =>
      JSON.stringify([
        {
          Created: "2026-11-22T01:41:28Z",
          State: { Status: "running", Pid: 2048, StartedAt: "2026-11-22T01:41:29Z" },
          HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
          Config: {
            Entrypoint: ["/bin/bash", "-ec", 'mkdir -p /persist/slots\nexec /entrypoint.sh "$@"'],
            Cmd: ["./bin/Runner.Listener", "run", "--startuptype", "service"],
            WorkingDir: "/actions-runner",
            Env: [],
            Labels: {},
          },
          Mounts: [],
          NetworkSettings: { Ports: {}, Networks: {} },
        },
      ]);
    window.__ipc.handlers.docker_container_stats = () => ({
      cpuPerc: "0.50%",
      memUsage: "128MiB / 8GiB",
      memPerc: "1.56%",
      netIo: "0B / 0B",
      blockIo: "0B / 0B",
      pids: "4",
    });
    window.__ipc.handlers.docker_events = () => new Promise(() => {});
    window.__ipc.handlers.cancel_request = () => null;

    const storeModule = "/src/features/services/store.ts";
    const treeModule = "/src/features/services/tree.ts";
    const { useServices } = await import(/* @vite-ignore */ storeModule);
    const { useServicesTree } = await import(/* @vite-ignore */ treeModule);
    useServices.setState({
      settings: { connections: [{ id: "local", name: "Docker", endpoint: { kind: "default" } }], registries: [] },
      conns: { local: { snapshot, loading: false, error: null } },
      detailTab: "dashboard",
    });
    useServicesTree.setState({
      expanded: new Set(["docker:local", "docker:local:compose:selfhost"]),
      selectedKey: `docker:local:container:${runnerId}`,
      selectedKeys: new Set([`docker:local:container:${runnerId}`]),
    });
  });

  await page.keyboard.press("Meta+8");
  const services = page.getByRole("region", { name: "Services", exact: true });
  await expect(services.getByText("Container Overview")).toBeVisible();

  // Clicking Jump to Source on the Command row opens docker-compose.yml with caret on `command:` value
  await services.getByRole("button", { name: "Jump to Source", exact: true }).click();
  const editor = page.locator(".cm-editor");
  await expect(editor.locator(".cm-activeLine")).toHaveText(
    '    command: ["./bin/Runner.Listener", "run", "--startuptype", "service"]',
  );
  const caret = await page.evaluate(async () => {
    const api = await import(/* @vite-ignore */ "/src/editor/api.ts" as string);
    const view = api.activeEditor()?.view;
    if (!view) return null;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { line: line.number - 1, col: head - line.from };
  });
  expect(caret).toEqual({ line: 11, col: 13 });

  // F4 on a Compose container node jumps to its service declaration
  const tree = services.getByRole("tree", { name: "Services", exact: true });
  await tree.getByRole("treeitem", { name: /github-runner/ }).click();
  await page.keyboard.press("F4");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  github-runner:");
  await tree.getByRole("treeitem", { name: /postgres/ }).click();
  await page.keyboard.press("F4");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  postgres:");
});

test("Docker Compose dashboard shows per-service resource usage and named project volumes", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    (window as unknown as { __cpuPerc: string }).__cpuPerc = "6.25%";
    const anonName = "37cc33a7d603260a82a378d7d3eeb835b748b5712614e2e5b4a3d6572f5e1e71";
    const snapshot = {
      availability: { kind: "ready", clientVersion: "28.0.1", serverVersion: "28.0.1", context: null },
      executable: "/usr/bin/docker",
      containers: [
        {
          id: "db-1",
          name: "shop-db-1",
          image: "postgres:16",
          command: "postgres",
          state: "running",
          status: "Up 15 minutes",
          ports: "127.0.0.1:5432->5432/tcp",
          createdAt: "2026-04-20T05:00:00Z",
          composeProject: "shop",
          composeService: "db",
          composeWorkingDir: "/work/shop",
          composeFiles: ["/work/shop/docker-compose.yml"],
          mounts: ["shop_pgdata"],
          networks: ["shop_default"],
        },
        {
          id: "api-1",
          name: "shop-api-1",
          image: "node:22",
          command: "node server.js",
          state: "exited",
          status: "Exited (0) 2 minutes ago",
          ports: "",
          createdAt: "2026-04-20T05:00:00Z",
          composeProject: "shop",
          composeService: "api",
          composeWorkingDir: "/work/shop",
          composeFiles: ["/work/shop/docker-compose.yml"],
          mounts: [],
          networks: ["shop_default"],
        },
      ],
      images: [],
      volumes: [
        {
          name: anonName,
          driver: "local",
          mountpoint: `/var/lib/docker/volumes/${anonName}/_data`,
          composeProject: "shop",
          scope: "local",
          labels: { "com.docker.volume.anonymous": "" },
        },
        {
          name: "shop_pgdata",
          driver: "local",
          mountpoint: "/var/lib/docker/volumes/shop_pgdata/_data",
          composeProject: "shop",
          scope: "local",
          labels: {
            "com.docker.compose.project": "shop",
            "com.docker.compose.volume": "pgdata",
          },
        },
        {
          name: "other_cache",
          driver: "local",
          mountpoint: "/var/lib/docker/volumes/other_cache/_data",
          composeProject: "other",
          scope: "local",
          labels: {
            "com.docker.compose.project": "other",
            "com.docker.compose.volume": "cache",
          },
        },
      ],
      networks: [{ id: "net-1", name: "shop_default", driver: "bridge", scope: "local", composeProject: "shop" }],
      errors: [],
    };

    window.__ipc.handlers.docker_settings = () => ({
      connections: [{ id: "default", name: "Docker", endpoint: { kind: "default" } }],
      registries: [],
    });
    window.__ipc.handlers.docker_snapshot = () => snapshot;
    window.__ipc.handlers.docker_events = () => new Promise(() => {});
    window.__ipc.handlers.docker_inspect = () => "[]";
    window.__ipc.handlers.docker_container_stats = ({ id }) => {
      if (id !== "db-1") throw { kind: "notFound", message: "container not running", detail: null };
      return {
        cpuPerc: (window as unknown as { __cpuPerc: string }).__cpuPerc,
        memUsage: "128MiB / 2GiB",
        memPerc: "6.25%",
        netIo: "2.4MB / 980kB",
        blockIo: "12MB / 4.1MB",
        pids: "17",
      };
    };

    const storeMod = "/src/features/services/store.ts";
    const treeMod = "/src/features/services/tree.ts";
    const { useServices } = await import(/* @vite-ignore */ storeMod);
    const { useServicesTree } = await import(/* @vite-ignore */ treeMod);
    useServices.setState({
      settings: { connections: [{ id: "default", name: "Docker", endpoint: { kind: "default" } }], registries: [] },
      conns: { default: { snapshot, loading: false, error: null } },
    });
    useServicesTree.setState({
      expanded: new Set(["docker:default"]),
      selectedKey: "docker:default:compose:shop",
      selectedKeys: new Set(["docker:default:compose:shop"]),
    });
  });

  await page.keyboard.press("Meta+8");
  const services = page.getByRole("region", { name: "Services", exact: true });
  const detail = services.locator("[data-panel][id=services-detail]");
  await expect(detail.getByText("Compose project 'shop'")).toBeVisible();

  const dbRow = detail.locator("tr", { hasText: "shop-db-1" });
  const apiRow = detail.locator("tr", { hasText: "shop-api-1" });
  await expect(dbRow).toContainText("6.25%");
  await expect(dbRow).toContainText("128MiB / 2GiB (6.25%)");
  await expect(dbRow).toContainText("2.4MB / 980kB");
  await expect(dbRow).toContainText("12MB / 4.1MB");
  await expect(dbRow).toContainText("17");
  await expect(apiRow).toContainText("Exited (0) 2 minutes ago");

  // Stopped service container is never queried for live stats, and no manual Refresh button is shown.
  const queriedIds = (await ipcCalls(page, "docker_container_stats")).map((c) => c.id);
  expect(new Set(queriedIds)).toEqual(new Set(["db-1"]));
  await expect(detail.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);

  // Running service metrics auto-refresh in place without user action.
  await page.evaluate(() => {
    (window as unknown as { __cpuPerc: string }).__cpuPerc = "18.50%";
  });
  await expect(dbRow).toContainText("18.50%", { timeout: 5000 });

  // Named Compose volume appears with logical name + driver; anonymous and other-project volumes do not.
  const volumeButton = detail.getByRole("button", { name: /shop_pgdata/ });
  await expect(volumeButton).toContainText("pgdata · local");
  await expect(detail.getByText("other_cache")).toHaveCount(0);
  await expect(detail.getByText(/37cc33a7/)).toHaveCount(0);

  // Clicking the named volume opens its Volume dashboard and links back to the Compose project.
  await volumeButton.click();
  await expect(detail.getByText("Volume Overview")).toBeVisible();
  await detail.getByRole("button", { name: "shop", exact: true }).click();
  await expect(detail.getByText("Compose project 'shop'")).toBeVisible();

  // Clicking a service in the table navigates to its Container dashboard, which auto-refreshes live stats.
  await detail.getByRole("button", { name: "shop-db-1", exact: true }).click();
  await expect(detail.getByText("Container Overview")).toBeVisible();
  await expect(detail).toContainText("18.50%");
  await page.evaluate(() => {
    (window as unknown as { __cpuPerc: string }).__cpuPerc = "27.40%";
  });
  await expect(detail).toContainText("27.40%", { timeout: 5000 });
});
