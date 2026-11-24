/**
 * A debugging session: a breakpoint set in the editor reaches the adapter, the session stops there
 * with its frames and variables, and stepping and resuming go back to the adapter. The adapter is
 * stubbed at the IPC layer; `crates/ide-dap/tests` drives real ones.
 */
import type { JvmMemoryResult } from "../src/platform/ipc";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/build.gradle.kts`;
const SESSION = 3;

test("stops at a breakpoint, shows frames and variables, steps and resumes", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ file, root, session }) => {
      const config = {
        id: "python:app",
        name: "app",
        kind: "python",
        command: "python3",
        args: ["app.py"],
        cwd: root,
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: "debugpy",
      };
      const h = window.__ipc.handlers;
      const debug = (event: Record<string, unknown>) => window.__ipc.emit({ type: "debug", session, event });
      const stopAt = (line: number) => {
        h.debug_stack_trace = () => [
          { id: 11, name: "create", path: file, line, column: 0, presentationHint: null },
          { id: 12, name: "handle", path: file, line: 16, column: 0, presentationHint: null },
        ];
        debug({ kind: "stopped", threadId: 1, reason: "breakpoint", description: null, allThreadsStopped: true });
      };
      h.run_configs = () => [config];
      h.run_apply_settings = (args) => args.configs;
      h.debug_set_breakpoints = (args) =>
        (args.breakpoints as { line: number }[]).map((b, i) => ({
          id: i + 1,
          verified: true,
          line: b.line,
          message: null,
        }));
      h.debug_start = () => {
        setTimeout(() => {
          debug({ kind: "started", name: config.name, adapter: "debugpy", parent: null });
          debug({ kind: "initialized" });
          stopAt(20);
        }, 50);
        return session;
      };
      h.debug_threads = () => [{ id: 1, name: "MainThread" }];
      h.debug_scopes = () => [{ name: "Locals", variablesReference: 100, expensive: false }];
      h.debug_variables = () => [
        {
          name: "req",
          value: "CreateOrderRequest(sku='A-1', qty=2)",
          typeName: "CreateOrderRequest",
          variablesReference: 0,
          evaluateName: "req",
        },
        { name: "qty", value: "2", typeName: "int", variablesReference: 0, evaluateName: "qty" },
      ];
      h.debug_step = () => {
        setTimeout(() => {
          debug({ kind: "continued", threadId: 1, allThreadsContinued: true });
          stopAt(21);
        }, 50);
        return null;
      };
      h.debug_resume = () => {
        setTimeout(() => {
          debug({ kind: "continued", threadId: 1, allThreadsContinued: true });
          debug({ kind: "exited", code: 0 });
          debug({ kind: "terminated" });
        }, 50);
        return null;
      };
      const runModule = "/src/features/run/store.ts";
      const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
      await loadConfigs();
      selectConfig(config.id);
    },
    { file: FILE, root: ROOT, session: SESSION },
  );

  // Breakpoint and execution lines carry CSS-module classes (`_bpLine_<hash>`).
  const line = (text: string) => editor.locator(".cm-line", { hasText: text });
  await line("val order: Order").click();
  await page.keyboard.press("Meta+F8");
  await expect(line("val order: Order")).toHaveClass(/_bpLine_/);

  await page.keyboard.press("Control+d");
  await expect.poll(() => ipcCalls(page, "debug_start")).toHaveLength(1);
  const set = (await ipcCalls(page, "debug_set_breakpoints")).filter((a) => a.path === FILE).at(-1);
  expect(set?.breakpoints).toEqual([expect.objectContaining({ line: 20 })]);

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await expect(debug.getByText("create", { exact: true })).toBeVisible();
  await expect(debug.getByText("handle", { exact: true })).toBeVisible();
  await expect(debug.getByText("CreateOrderRequest(sku='A-1', qty=2)")).toBeVisible();
  await expect(line("val order: Order")).toHaveClass(/_execLine_/);

  await page.keyboard.press("F8");
  await expect.poll(() => ipcCalls(page, "debug_step")).toEqual([{ session: SESSION, threadId: 1, kind: "over" }]);
  await expect(line("return order.toDto()")).toHaveClass(/_execLine_/);
  await expect(line("val order: Order")).not.toHaveClass(/_execLine_/);

  await page.keyboard.press("F9");
  await expect.poll(() => ipcCalls(page, "debug_resume")).toHaveLength(1);
  await expect(debug.getByText("CreateOrderRequest(sku='A-1', qty=2)")).toBeHidden();
});

test("Memory gives class filtering the available toolbar width and exposes changed-only filtering", async ({
  workbench: page,
}) => {
  const rows = [
    { name: "OrderCache", instances: 64, deltaInstances: 12 },
    { name: "OrderRepository", instances: 16, deltaInstances: 0 },
  ].map((row) => ({ ...row, bytes: row.instances * 16, deltaBytes: null, module: null, ambiguous: false }));
  const result: JvmMemoryResult = {
    status: "ready",
    snapshot: {
      rows,
      totalInstances: 80,
      totalBytes: 1280,
      javaVersion: "21",
      takenWhileSuspended: true,
      hasBaseline: true,
      elapsedMs: 5,
      source: "debugger",
    },
  };
  await stubDesktop(page);
  await page.evaluate(
    async ({ result, id }) => {
      const caps = { jvmMemory: true, jvmHeap: true };
      window.__ipc.handlers.debug_capabilities = () => caps;
      window.__ipc.handlers.debug_jvm_memory_classes = () => result;
      const debugPath = "/src/features/debugger/state.ts";
      const { adoptSession } = await import(/* @vite-ignore */ debugPath);
      adoptSession(id, { adapter: "java-debug", name: "Billing Service", status: "paused", caps });
      const dockPath = "/src/workbench/toolwindows/store.ts";
      const layout = await import(/* @vite-ignore */ dockPath);
      layout.moveToolWindow("debug", "bottom");
      layout.setToolWindowSize("bottom", 300);
      layout.showToolWindow("debug", true);
    },
    { result, id: SESSION },
  );

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Memory" }).click();
  const toolbar = debug.getByRole("toolbar", { name: "Memory", exact: true });
  const filter = toolbar.getByRole("textbox", { name: "Filter classes" });
  const options = toolbar.getByRole("button", { name: "View Options" });
  const grid = debug.getByRole("grid", { name: "Memory", exact: true });
  await expect(grid.getByText("OrderRepository", { exact: true })).toBeVisible();
  expect((await filter.boundingBox())!.width).toBeGreaterThan((await toolbar.boundingBox())!.width / 2);

  await page.evaluate(async () => {
    const dockPath = "/src/workbench/toolwindows/store.ts";
    const layout = await import(/* @vite-ignore */ dockPath);
    layout.moveToolWindow("debug", "right");
    layout.setToolWindowSize("right", 330);
  });
  await expect.poll(async () => (await toolbar.boundingBox())!.width).toBeCloseTo(330, 0);
  const bar = (await toolbar.boundingBox())!;
  const gear = (await options.boundingBox())!;
  const input = (await filter.boundingBox())!;
  expect(input.width).toBeGreaterThan(bar.width / 2);
  expect(input.x + input.width).toBeLessThan(gear.x);
  expect(gear.x + gear.width).toBeLessThanOrEqual(bar.x + bar.width);

  await filter.fill("cache");
  await expect(grid.getByText("OrderRepository", { exact: true })).toBeHidden();
  await toolbar.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(grid.getByText("OrderRepository", { exact: true })).toBeVisible();

  await options.press("Enter");
  const changed = page.getByRole("menuitemcheckbox", { name: "Changed only" });
  await expect(changed).not.toBeChecked();
  await changed.press("Enter");
  await expect(grid.getByText("OrderRepository", { exact: true })).toBeHidden();
  await expect(options).toHaveAttribute("aria-pressed", "true");
  await expect(options).toBeFocused();
  await options.press("Enter");
  await expect(changed).toBeChecked();
});

test("Evaluate keeps a multiline expression and its result visible in a short dialog", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 580, height: 420 });
  await stubDesktop(page);
  await page.evaluate(async (session) => {
    const handlers = window.__ipc.handlers;
    handlers.debug_capabilities = () => ({});
    handlers.debug_completions = () => [];
    handlers.debug_evaluate_in = () => ({
      name: "orderSummary",
      typeName: "OrderSummary",
      value: "total = 36",
      variablesReference: 210,
      evaluateName: null,
    });
    handlers.debug_variables = () => [
      { name: "tax", value: "4", typeName: "int", variablesReference: 0, evaluateName: null },
    ];
    const stateModule = "/src/features/debugger/state.ts";
    const { adoptSession } = await import(/* @vite-ignore */ stateModule);
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        editor: { ...settings?.editor, fontFamily: "Consolas", fontSize: 18, lineHeight: 28 },
      },
    });
    adoptSession(session, { name: "Checkout", adapter: "debugpy", status: "paused", selectedFrame: 11 });
  }, SESSION);

  await page.keyboard.press("Alt+F8");
  const dialog = page.getByRole("dialog", { name: "Evaluate expression" });
  const field = dialog.getByRole("textbox", { name: "Expression" });
  await expect(field).toHaveCSS("font-size", "18px");
  await expect(field).toHaveCSS("line-height", "28px");
  await expect(field).toHaveCSS("font-family", /^"?Consolas"?,/);
  const expression = ["orderSummary(", ...Array.from({ length: 12 }, (_, i) => `    item${i},`), ")"].join("\n");
  await field.fill(expression);
  await field.press("Enter");
  const result = dialog.getByRole("region", { name: "Result", exact: true }).getByRole("tree", {
    name: "Evaluation result",
  });
  const row = result.getByRole("treeitem").first();
  await expect(row).toContainText("total = 36");
  await expect
    .poll(() =>
      dialog.locator("[data-dialog-body]").evaluate((body) => {
        const area = body.querySelector("textarea")!;
        const resultRow = body.querySelector('[role="treeitem"]')!.getBoundingClientRect();
        const bounds = body.getBoundingClientRect();
        return (
          body.scrollHeight <= body.clientHeight + 1 &&
          area.scrollHeight > area.clientHeight &&
          resultRow.top >= bounds.top &&
          resultRow.bottom <= bounds.bottom
        );
      }),
    )
    .toBe(true);
  await row.click();
  await row.press("ArrowRight");
  await expect(result.getByText("tax", { exact: true })).toBeVisible();

  await field.fill("otherExpression");
  const historyButton = dialog.getByRole("button", { name: "History", exact: true });
  const history = page.getByRole("menu", { name: "Expression history" });
  const option = history.getByRole("menuitem", { name: /orderSummary/ });
  await historyButton.click();
  await expect(option).toBeVisible();
  await expect(option).toHaveCSS("font-size", "18px");
  await expect
    .poll(async () => {
      const inputBounds = (await field.locator("..").boundingBox())!;
      const menuBounds = (await history.locator("..").boundingBox())!;
      return Math.max(Math.abs(inputBounds.x - menuBounds.x), Math.abs(inputBounds.width - menuBounds.width));
    })
    .toBeLessThan(1);
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(historyButton).toBeFocused();
  await historyButton.press("Enter");
  await option.press("Enter");
  await expect(field).toHaveValue(expression);
  await expect(field).toBeFocused();
});

test("Variables keeps evaluation, watches and expression history together in a narrow dock", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 720, height: 620 });
  await stubDesktop(page);
  await page.evaluate(async (session) => {
    const handlers = window.__ipc.handlers;
    handlers.debug_capabilities = () => ({});
    handlers.debug_completions = () => [];
    handlers.debug_scopes = () => [];
    handlers.debug_evaluate_in = () => ({
      name: "result",
      value: "42",
      typeName: "int",
      variablesReference: 0,
      evaluateName: null,
    });
    const statePath = "/src/features/debugger/state.ts";
    const historyPath = "/src/features/debugger/ui/expressionHistory.ts";
    const projectPath = "/src/platform/project.ts";
    const servicesPath = "/src/workbench/contributions.ts";
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const { adoptSession } = await import(/* @vite-ignore */ statePath);
    const { pushHistory } = await import(/* @vite-ignore */ historyPath);
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    const { toolWindowService } = await import(/* @vite-ignore */ servicesPath);
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutPath);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: { ...settings, editor: { ...settings?.editor, fontFamily: "Consolas", fontSize: 18 } },
    });
    pushHistory("evaluate", "order.total + tax");
    pushHistory("evaluate", "if ready:\n    settle()");
    adoptSession(session, { name: "Checkout", adapter: "debugpy", status: "paused", selectedFrame: 11 });
    moveToolWindow("debug", "right");
    setToolWindowSize("right", 285);
    toolWindowService().show("debug", true);
  }, SESSION);

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  const variables = debug.getByRole("tab", { name: "Variables", exact: true });
  if (await variables.isVisible()) await variables.click();
  const field = debug.getByRole("textbox", { name: "Evaluate expression", exact: true });
  const historyButton = debug.getByRole("button", { name: "History", exact: true });
  const watch = debug.getByRole("button", { name: "Add to Watches", exact: true });
  await expect(field).toBeVisible();
  await expect(historyButton).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Evaluate expression");
  await expect(field).toHaveCSS("font-family", /^"?Consolas"?,/);
  await expect(field).toHaveCSS("font-size", "13px");
  expect((await field.boundingBox())!.width).toBeGreaterThan(100);
  expect((await watch.boundingBox())!.x).toBeLessThan((await historyButton.boundingBox())!.x);

  await historyButton.click();
  const menu = page.getByRole("menu", { name: "Expression history", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText(["order.total + tax"]);
  const row = (await field.locator("..").boundingBox())!;
  const popup = (await menu.locator("..").boundingBox())!;
  expect(popup.x).toBeCloseTo(row.x, 0);
  expect(popup.width).toBeCloseTo(row.width, 0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(historyButton).toBeFocused();

  await historyButton.press("Enter");
  await menu.getByRole("menuitem", { name: "order.total + tax" }).press("Enter");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("order.total + tax");
  await field.press("Enter");
  await expect
    .poll(() => ipcCalls(page, "debug_evaluate_in"))
    .toContainEqual(expect.objectContaining({ expression: "order.total + tax", context: "repl" }));

  await field.fill("order.total");
  await watch.click();
  await expect(field).toHaveValue("");
  await expect
    .poll(() => ipcCalls(page, "debug_evaluate_in"))
    .toContainEqual(expect.objectContaining({ expression: "order.total", context: "watch" }));
  await historyButton.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["order.total", "order.total + tax"]);
});
