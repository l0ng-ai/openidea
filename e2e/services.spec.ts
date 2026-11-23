import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

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

test("Docker Compose container Jump to Source opens the Compose file with caret on the command line", async ({
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

  // Pressing F4 on a Compose container without `command:`/`entrypoint:` jumps to its service declaration
  const tree = services.getByRole("tree", { name: "Services", exact: true });
  await tree.getByRole("treeitem", { name: /postgres/ }).click();
  await page.keyboard.press("F4");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  postgres:");
});
