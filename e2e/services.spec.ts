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
