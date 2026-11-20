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
