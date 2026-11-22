/**
 * Running a configuration: output streams into the Run tool window, the exit shows, and Stop ends
 * the process. Processes are stubbed at the IPC layer; `crates/ide-run` covers spawning them.
 */
import type { Page } from "@playwright/test";
import type { RunConfig } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const RUN_ID = 7;

/** One saved `npm run dev` configuration; `run_start` prints `output` and exits with `exit` unless null. */
async function stubRun(
  page: Page,
  output: { kind: string; text: string }[],
  exit: number | null,
  overrides: Partial<RunConfig> = {},
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ output, exit, runId, overrides }) => {
      const config = {
        id: "npm:dev",
        name: "dev",
        kind: "npm",
        command: "npm",
        args: ["run", "dev"],
        cwd: "/dev/acme-api",
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: null,
        ...overrides,
      };
      const h = window.__ipc.handlers;
      h.run_configs = () => [config];
      h.run_apply_settings = (args) => args.configs;
      h.run_start = (args) => {
        setTimeout(() => {
          for (const chunk of output) window.__ipc.send(args.onOutput, chunk);
          if (exit !== null) setTimeout(() => window.__ipc.emit({ type: "runExited", run: runId, code: exit }), 50);
        }, 50);
        return { id: runId, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
      };
      h.run_stop = () => {
        setTimeout(() => window.__ipc.emit({ type: "runExited", run: runId, code: 143 }), 50);
        return null;
      };
      const runModule = "/src/features/run/store.ts";
      const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
      await loadConfigs();
      selectConfig(config.id);
    },
    { output, exit, runId: RUN_ID, overrides },
  );
}

test("⌃R runs the selected configuration and shows its output and exit", async ({ workbench: page }) => {
  await stubRun(
    page,
    [
      { kind: "stdout", text: "> acme-api@1.0.0 dev\n" },
      { kind: "stdout", text: "Server listening on http://localhost:8080\n" },
      { kind: "stderr", text: "warning: config/dev.json not found, using defaults\n" },
    ],
    0,
  );
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run).toBeVisible();
  await expect(run.getByText("Server listening on http://localhost:8080")).toBeVisible();
  await expect(run.getByText("warning: config/dev.json not found, using defaults")).toBeVisible();
  // Once the process exits, Stop is off and the session's tab tells the exit code.
  await expect(run.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(run.getByRole("tab", { name: "dev" })).toHaveAttribute("data-tooltip", /exit code 0$/);
  const [started] = await ipcCalls(page, "run_start");
  expect(started).toMatchObject({ config: { id: "npm:dev", command: "npm", args: ["run", "dev"] } });
});

test("expanded console folds stay reachable at the start of their rows", async ({ workbench: page }) => {
  const heading = "Reconciling orders for the overnight settlement and inventory reporting pipeline";
  await stubRun(
    page,
    [
      {
        kind: "stdout",
        text: [
          "TRACE Reused inventory connection",
          "TRACE Loaded warehouse configuration",
          heading,
          "TRACE Checked warehouse audit result",
          "TRACE Updated inventory snapshot",
          "Processed 24 orders",
          "",
        ].join("\n"),
      },
    ],
    null,
  );
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: { ...settings, console: { ...settings?.console, foldPatterns: ["TRACE "] } },
    });
    moveToolWindow("run", "right");
    setToolWindowSize("right", 320);
  });
  await page.keyboard.press("Control+r");
  const log = page.getByRole("region", { name: "Run", exact: true }).getByRole("log");
  const expand = log.getByTitle("Expand folded lines", { exact: true });
  const collapse = log.getByRole("button", { name: "Collapse folded lines", exact: true });
  await expect(expand).toHaveCount(2);

  await expand.first().click();
  await expect(log.getByText("TRACE Reused inventory connection", { exact: true })).toBeVisible();
  await expect(collapse).toHaveCount(1);
  await collapse.press("Space");
  await expect(expand).toHaveCount(2);

  await expand.first().press("Enter");
  await expect(collapse).toBeFocused();
  await expand.last().click();
  await expect(collapse).toHaveCount(2);
  for (const scrollLeft of [0, 120]) {
    await log.evaluate((element, x) => (element.scrollLeft = x), scrollLeft);
    expect(await log.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
    for (const control of await collapse.all()) {
      const aligned = await control.evaluate((button) => {
        const log = button.closest('[role="log"]')!.getBoundingClientRect();
        const row = button.closest("[data-index]")!.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return Math.abs(box.left - log.left) <= 1 && box.top >= row.top && box.bottom <= row.bottom + 1;
      });
      expect(aligned).toBe(true);
    }
  }
  await collapse.first().click();
  await collapse.first().click();
  await expect(expand).toHaveCount(2);
  expect(await ipcCalls(page, "run_stdin")).toEqual([]);
});

test("⌘F2 stops a running process", async ({ workbench: page }) => {
  await stubRun(page, [{ kind: "stdout", text: "Watching for changes…\n" }], null);
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByText("Watching for changes…")).toBeVisible();
  await expect(run.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.keyboard.press("Meta+F2");
  await expect.poll(() => ipcCalls(page, "run_stop")).toEqual([{ id: RUN_ID }]);
  await expect(run.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(run.getByRole("tab", { name: "dev" })).toHaveAttribute("data-tooltip", /exit code 143$/);
});

test("a long Run tab fits its side panel with room for the pin and close buttons", async ({ workbench: page }) => {
  const name = "orders:reconcile:weekly-report-from-production-catalog";
  await stubRun(page, [{ kind: "stdout", text: "Order report ready.\n" }], 0, { name });
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ path);
    moveToolWindow("run", "right");
    setToolWindowSize("right", 240);
  });
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  const strip = run.getByRole("tablist", { name: "Run sessions" });
  const selected = strip.getByRole("tab", { name, selected: true });
  await expect(selected).toBeVisible();
  await expect
    .poll(() =>
      selected.evaluate((tab) => {
        const slot = tab.parentElement!;
        const bounds = slot.getBoundingClientRect();
        const clip = slot.parentElement!.getBoundingClientRect();
        return bounds.left >= clip.left - 1 && bounds.right <= clip.right + 1;
      }),
    )
    .toBe(true);
  await expect(run.getByRole("button", { name: "Show Hidden Tabs" })).toBeHidden();
  await expect(selected).toHaveAttribute("data-tooltip", new RegExp(`^${name}.*exit code 0$`));

  await selected.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin Tab", exact: true }).click();
  await strip.getByRole("button", { name: "Unpin Tab", exact: true }).click();
  await strip.getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(run).toBeHidden();
});

test("the Run toolbar keeps primary actions in one row in a side dock", async ({ workbench: page }) => {
  const output = "Waiting for orders. ".repeat(8).trim();
  await stubRun(page, [{ kind: "stdout", text: `${output}\n` }], null);
  const dock = async (width: number) => {
    await page.evaluate(async (width) => {
      const path = "/src/workbench/toolwindows/store.ts";
      const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ path);
      moveToolWindow("run", "right");
      setToolWindowSize("right", width);
    }, width);
  };
  await dock(200);
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  const toolbar = run.getByRole("toolbar", { name: "Run actions" });
  const console = run.getByRole("log");
  await expect(console).toContainText(output);
  await expect
    .poll(() => toolbar.evaluate((el) => new Set([...el.querySelectorAll("button")].map((b) => b.offsetTop)).size))
    .toBe(1);
  const more = toolbar.getByRole("button", { name: "More Actions" });
  const menu = page.getByRole("menu", { name: "More Actions" });
  await more.press("Enter");
  const wrap = menu.getByRole("menuitemcheckbox", { name: "Soft-Wrap" });
  await expect(wrap).toHaveAttribute("aria-checked", "false");
  await expect(menu.getByRole("menuitemcheckbox", { name: "Scroll to End" })).toHaveAttribute("aria-checked", "true");
  await wrap.click();
  await expect(menu).toBeHidden();
  await expect.poll(() => console.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  await dock(340);
  await expect(toolbar.getByRole("button", { name: "Soft-Wrap" })).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar.getByRole("button", { name: "Scroll to End" })).toBeVisible();
  await more.click();
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Edit Configurations…" }).click();
  await expect(page.getByRole("dialog", { name: "Run/Debug Configurations" })).toBeVisible();
});

test("a short Run pane has room for the full toolbar above the output", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 400, height: 500 });
  const output = "Watching for changes…";
  await stubRun(page, [{ kind: "stdout", text: `${output}\n` }], null);
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByText(output)).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const { setToolWindowSize } = await import(/* @vite-ignore */ path);
    setToolWindowSize("bottom", 160);
  });
  const toolbar = run.getByRole("toolbar", { name: "Run actions" });
  const clipped = await toolbar.evaluate((el) => {
    const bar = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("button")).flatMap((button) => {
      const box = button.getBoundingClientRect();
      return box.left < bar.left - 1 || box.right > bar.right + 1 || box.bottom > bar.bottom + 1
        ? [button.getAttribute("aria-label")]
        : [];
    });
  });
  expect(clipped).toEqual([]);
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  const toolbarBox = (await toolbar.boundingBox())!;
  const consoleBox = (await run.getByRole("log").boundingBox())!;
  expect(consoleBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height - 1);
  await toolbar.getByRole("button", { name: "Clear All" }).click();
  await expect(run.getByText(output)).toBeHidden();
  await toolbar.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => ipcCalls(page, "run_stop")).toEqual([{ id: RUN_ID }]);
});

test("Go reruns keep each package's exact failures and the original configuration", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const config = {
      id: "go:test",
      name: "All tests",
      kind: "go",
      command: "go",
      args: ["test", "-json", "./..."],
      cwd: "/dev/acme-api",
      env: {},
      detected: false,
      isTest: true,
      debugAdapter: "delve",
    };
    const h = window.__ipc.handlers;
    h.run_configs = () => [config];
    h.run_apply_settings = (args) => args.configs;
    let id = 20;
    h.run_start = (args) => {
      const run = id++;
      setTimeout(() => {
        for (const [pkg, name] of [
          ["example.com/a", "TestA/one"],
          ["example.com/b", "TestB/two/leaf"],
        ]) {
          for (const event of [
            { Action: "run", Package: pkg, Test: name },
            { Action: "fail", Package: pkg, Test: name },
            { Action: "fail", Package: pkg },
          ])
            window.__ipc.send(args.onOutput, { kind: "stdout", text: JSON.stringify(event) + "\n" });
        }
        window.__ipc.emit({ type: "runExited", run, code: 1 });
      }, 50);
      return { id: run, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
    };
    const module = "/src/features/run/store.ts";
    const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ module);
    await loadConfigs();
    selectConfig(config.id);
  });
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await run.getByRole("button", { name: "Rerun Failed Tests", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(3);
  const calls = await ipcCalls(page, "run_start");
  expect(calls.slice(1).map((call) => (call.config as { args: string[] }).args)).toEqual([
    ["test", "-json", "-run", "^TestA$/^one$", "example.com/a"],
    ["test", "-json", "-run", "^TestB$/^two$/^leaf$", "example.com/b"],
  ]);
  const originals = await page.evaluate(async () => {
    const module = "/src/features/run/store.ts";
    const { useRun } = await import(/* @vite-ignore */ module);
    return useRun.getState().sessions.map((session: { baseConfig?: { args: string[] } }) => session.baseConfig?.args);
  });
  expect(originals).toEqual([
    ["test", "-json", "./..."],
    ["test", "-json", "./..."],
  ]);
});

test("test results keep counts, actions and selected output visible as the pane narrows", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1060, height: 740 });
  const goPackage = "example.com/checkout";
  const name = "TestCheckoutTotalsWithDiscountsAndPendingInventoryReservations";
  const message = "expected subtotal 42, got 37";
  const records = [
    { Action: "run", Test: name },
    { Action: "output", Test: name, Output: message + "\n" },
    { Action: "fail", Test: name, Elapsed: 0.125 },
    { Action: "pass", Test: "TestPayment", Elapsed: 0.02 },
    { Action: "skip", Test: "TestDelayedShipping" },
    { Action: "fail", Elapsed: 0.17 },
  ];
  await stubRun(
    page,
    records.map((record) => ({ kind: "stdout", text: JSON.stringify({ Package: goPackage, ...record }) + "\n" })),
    1,
    {
      id: "go:checkout-tests",
      name: "Checkout tests",
      kind: "go",
      command: "go",
      args: ["test", "-json"],
      isTest: true,
    },
  );
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  const tree = run.getByRole("tree", { name: "Test results" });
  const row = tree.getByRole("treeitem", { name: new RegExp(name) });
  await row.click();
  const output = run.getByRole("log");
  await expect(output).toContainText(message);
  await expect.poll(async () => (await output.boundingBox())!.x > (await tree.boundingBox())!.x).toBe(true);
  await page.setViewportSize({ width: 540, height: 740 });
  await expect
    .poll(async () => {
      const [list, console] = await Promise.all([tree.boundingBox(), output.boundingBox()]);
      return !!list && !!console && console.y >= list.y + list.height - 1;
    })
    .toBe(true);
  const summary = run.getByRole("status").filter({ hasText: "1 failing" });
  for (const count of ["1 failing", "1 passed", "1 ignored"]) await expect(summary.getByText(count)).toBeVisible();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row.getByText("125 ms")).toBeVisible();
  await expect(output).toContainText(message);
  const toolbar = run.getByRole("toolbar", { name: "Test results" });
  await toolbar.getByRole("button", { name: "More Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Collapse All" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Export Test Results…" })).toBeVisible();
  await page.keyboard.press("Escape");
  const divider = run.getByRole("separator");
  const treeHeight = async () => (await tree.boundingBox())!.height;
  const beforeResize = await treeHeight();
  await divider.press("ArrowDown");
  await expect.poll(treeHeight).toBeGreaterThan(beforeResize + 1);
  const customizedHeight = await treeHeight();
  await page.setViewportSize({ width: 1060, height: 740 });
  await expect.poll(async () => (await output.boundingBox())!.x > (await tree.boundingBox())!.x).toBe(true);
  await page.setViewportSize({ width: 540, height: 740 });
  await expect.poll(async () => Math.abs((await treeHeight()) - customizedHeight)).toBeLessThan(2);
  await expect(output).toContainText(message);
});

test("test results keep elapsed time beside the counts", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1060, height: 740 });
  const lines = [
    "test_tax (test_ledger.CheckoutTests.test_tax) ... ok",
    "test_refund (test_ledger.CheckoutTests.test_refund) ... FAIL",
    "test_callback (test_ledger.CheckoutTests.test_callback) ... skipped 'Requires a callback'",
    "Ran 3 tests in 0.170s",
    "FAILED (failures=1, skipped=1)",
  ];
  await stubRun(page, [{ kind: "stderr", text: lines.join("\n") + "\n" }], 1, {
    id: "django:checkout-tests",
    name: "Checkout tests",
    kind: "django-test",
    command: "python",
    args: ["manage.py", "test", "-v", "2"],
    isTest: true,
  });
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  const summary = run.getByRole("status").filter({ hasText: "1 failing" });
  const ignored = summary.getByText("1 ignored", { exact: true });
  const elapsed = summary.getByText("170 ms", { exact: true });
  await expect(elapsed).toBeVisible();
  for (const width of [1060, 540]) {
    await page.setViewportSize({ width, height: 740 });
    await expect
      .poll(async () => {
        const [count, duration] = await Promise.all([ignored.boundingBox(), elapsed.boundingBox()]);
        return count && duration && Math.abs(count.y - duration.y) <= 1 ? duration.x - count.x - count.width : Infinity;
      })
      .toBeLessThanOrEqual(12);
  }
  await expect(summary).toHaveCSS("border-bottom-width", "2px");
});

test("test results retain a running label after the first test starts", async ({ workbench: page }) => {
  const name = "TestCheckoutTotals";
  await stubRun(
    page,
    [{ kind: "stdout", text: JSON.stringify({ Package: "example.com/checkout", Action: "run", Test: name }) + "\n" }],
    null,
    {
      id: "go:checkout-tests",
      name: "Checkout tests",
      kind: "go",
      command: "go",
      args: ["test", "-json"],
      isTest: true,
    },
  );
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible();
  const summary = run.getByRole("status").filter({ hasText: "Running…" });
  await expect(summary).toBeVisible();
  await expect(summary).toHaveCSS("border-bottom-width", "2px");
});

test("test results group failure navigation and let users hide row durations", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 540, height: 740 });
  const first = "TestCheckoutTotalsWithTaxRoundingAndPendingRefunds";
  const second = "TestCheckoutTotalsWithDiscountsAndLateCouponAllocation";
  const records = [
    { Action: "output", Test: first, Output: "tax total differed\n" },
    { Action: "fail", Test: first, Elapsed: 0.125 },
    { Action: "output", Test: second, Output: "coupon allocation differed\n" },
    { Action: "fail", Test: second, Elapsed: 0.28 },
    { Action: "fail", Elapsed: 0.45 },
  ];
  await stubRun(
    page,
    records.map((record) => ({
      kind: "stdout",
      text: JSON.stringify({ Package: "example.com/checkout", ...record }) + "\n",
    })),
    1,
    {
      id: "go:checkout-tests",
      name: "Checkout tests",
      kind: "go",
      command: "go",
      args: ["test", "-json"],
      isTest: true,
    },
  );
  await page.keyboard.press("Control+r");

  const run = page.getByRole("region", { name: "Run", exact: true });
  const tree = run.getByRole("tree", { name: "Test results" });
  const toolbar = run.getByRole("toolbar", { name: "Test results" });
  const more = toolbar.getByRole("button", { name: "More Actions", exact: true });
  const firstRow = tree.getByRole("treeitem", { name: new RegExp(first) });
  const secondRow = tree.getByRole("treeitem", { name: new RegExp(second) });
  await firstRow.click();
  await more.click();
  const next = page.getByRole("menuitem", { name: /^Next Failed Test/ });
  await expect(next).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Previous Failed Test/ })).toHaveAttribute("aria-disabled", "true");
  await expect(toolbar.getByRole("button", { name: /Failed Test/ })).toHaveCount(0);
  await next.click();
  await expect(secondRow).toHaveAttribute("aria-selected", "true");
  const output = run.getByRole("log");
  await expect(output).toContainText("coupon allocation differed");

  await expect(secondRow.getByText("280 ms", { exact: true })).toBeVisible();
  const label = secondRow.getByText(second, { exact: true });
  const width = (await label.boundingBox())!.width;
  await more.click();
  await expect(page.getByRole("menuitem", { name: /^Next Failed Test/ })).toHaveAttribute("aria-disabled", "true");
  const options = page.getByRole("menuitem", { name: "Test Runner Options", exact: true });
  await page.keyboard.press("End");
  await expect(options).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const durations = page.getByRole("menuitemcheckbox", { name: "Show Test Durations", exact: true });
  await expect(durations).toHaveAttribute("aria-checked", "true");
  await durations.press("Enter");
  await expect(secondRow.getByText("280 ms", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await label.boundingBox())!.width).toBeGreaterThan(width);
  await expect(secondRow).toHaveAttribute("aria-selected", "true");
  await expect(output).toContainText("coupon allocation differed");
  const summary = run.getByRole("status").filter({ hasText: "2 failing" });
  await expect(summary.getByText("2 failing", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("openidea.run.testFilters")!).showDurations)).toBe(
    false,
  );
});

test("CMake builds the selected target in Build before starting only the application in Run", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const build = {
      id: "cmake:release:hello:build",
      name: "Build hello",
      kind: "cmake",
      command: "cmake",
      args: ["--build", "release", "--target", "hello", "--config", "Release"],
      cwd: null,
      env: {},
      detected: true,
      isTest: false,
      debugAdapter: null,
    };
    const app = {
      ...build,
      id: "cmake:release:hello",
      name: "hello [Release, release]",
      kind: "cmake-application",
      command: "/dev/acme-api/release/hello",
      args: [],
      debugAdapter: "lldb-dap",
      beforeLaunch: [{ kind: "build", target: build.id }],
    };
    const h = window.__ipc.handlers;
    h.run_configs = () => [build, app];
    h.run_apply_settings = (args) => args.configs;
    h.build_run = (args) => {
      window.__ipc.send(args.onEvent, { kind: "started", system: "cmake", title: "Build hello" });
      window.__ipc.send(args.onEvent, { kind: "output", text: "COMPILER_OUTPUT\n", stderr: false });
      return {
        system: "cmake",
        title: "Build hello",
        success: true,
        errors: 0,
        warnings: 0,
        durationMs: 1,
        messages: [],
      };
    };
    h.run_start = () => {
      setTimeout(() => window.__ipc.emit({ type: "runExited", run: 7, code: 0 }), 100);
      return { id: 7, configId: app.id, name: app.name, pid: 4242, running: true, pty: false };
    };
    const runModule = "/src/features/run/store.ts";
    const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
    await loadConfigs();
    selectConfig(app.id);
  });
  await page.getByRole("button", { name: "Build Project", exact: true }).click();
  const build = page.getByRole("region", { name: "Build", exact: true });
  await expect(build.getByText("COMPILER_OUTPUT", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "run_start")).toHaveLength(0);
  expect(await ipcCalls(page, "build_run")).toEqual([expect.objectContaining({ cmake: "cmake:release:hello:build" })]);
  await page.keyboard.press("Control+r");
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(1);
  expect(await ipcCalls(page, "build_run")).toHaveLength(2);
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByRole("tab", { name: "hello [Release, release]" })).toBeVisible();
  await expect(run.getByText("COMPILER_OUTPUT", { exact: true })).toHaveCount(0);
});
