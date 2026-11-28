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

test("Memory View shows the bytes at an address expression with hex and ASCII aligned", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async (id) => {
    // The reporter's `msg` (#5921) where GDB put it, 9 bytes into its row; other bytes count up.
    const msg = "Hello, World!\n\0";
    const at = 0x7fffffff9f69;
    const h = window.__ipc.handlers;
    const caps = { readMemory: true };
    h.debug_capabilities = () => caps;
    h.debug_evaluate_in = (args) => ({
      name: args.expression,
      value: '0x7fffffff9f69 "Hello, World!\\n"',
      typeName: "const char *",
      variablesReference: 0,
      evaluateName: args.expression,
      memoryReference: "0x7fffffff9f69",
    });
    h.debug_read_memory = (args) => {
      const start = Number(args.memoryReference) + (args.offset as number);
      const data = Array.from({ length: args.count as number }, (_, i) => {
        const a = start + i;
        return a >= at && a < at + msg.length ? msg.charCodeAt(a - at) : a & 0xff;
      });
      return { address: `0x${start.toString(16)}`, data, unreadableBytes: 0 };
    };
    const debugPath = "/src/features/debugger/state.ts";
    const { adoptSession } = await import(/* @vite-ignore */ debugPath);
    adoptSession(id, { adapter: "gdb", name: "app-c", status: "paused", stops: 1, caps });
    const dockPath = "/src/workbench/toolwindows/store.ts";
    const layout = await import(/* @vite-ignore */ dockPath);
    layout.moveToolWindow("debug", "bottom");
    layout.setToolWindowSize("bottom", 360);
    layout.showToolWindow("debug", true);
  }, SESSION);

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Memory View" }).click();
  const field = debug.getByRole("textbox", { name: "Address or expression" });
  await field.fill("&msg[0]");
  await field.press("Enter");
  const grid = debug.getByRole("grid", { name: "Memory", exact: true });
  await expect(grid.getByRole("rowheader", { name: "0x00007FFFFFFF9F60" })).toBeVisible();
  expect(await ipcCalls(page, "debug_read_memory")).toEqual([
    { session: SESSION, memoryReference: "0x7fffffff9f69", offset: -9, count: 256 },
  ]);
  // Monospaced columns: each row's hex and ASCII start where the row above starts them.
  const rows = grid.getByRole("row");
  const left = async (row: number, cell: number) =>
    (await rows.nth(row).getByRole("gridcell").nth(cell).boundingBox())!.x;
  for (const cell of [0, 1]) expect(await left(2, cell)).toBeCloseTo(await left(1, cell), 0);
  await expect(rows.nth(1).getByRole("gridcell").nth(1)).toHaveText("`abcdefghHello, ");
  await expect(rows.nth(2).getByRole("gridcell").nth(1)).toHaveText(/^World!\.\./);
});

test("Disassembly shows the selected frame's instructions with the current one highlighted", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async (id) => {
    // GDB 17.1's `disassemble /r sum` of a C program (#5922), stopped at `sum+78` on the loop line.
    const SUM = 0x5555555551a7;
    const code: [number, string, string][] = [
      [62, "c745e000000000", "movl   $0x0,-0x20(%rbp)"],
      [69, "c745e400000000", "movl   $0x0,-0x1c(%rbp)"],
      [76, "eb26", "jmp    0x55555555521b <sum+116>"],
      [78, "8b45e4", "mov    -0x1c(%rbp),%eax"],
      [81, "4898", "cltq"],
      [83, "488d14c500000000", "lea    0x0(,%rax,8),%rdx"],
      [91, "488b45d8", "mov    -0x28(%rbp),%rax"],
      [95, "4801d0", "add    %rdx,%rax"],
      [98, "488b00", "mov    (%rax),%rax"],
      [101, "4889c7", "mov    %rax,%rdi"],
      [104, "e875ffffff", "call   0x555555555189 <parse>"],
      [109, "0145e0", "add    %eax,-0x20(%rbp)"],
      [112, "8345e401", "addl   $0x1,-0x1c(%rbp)"],
      [116, "8b45e4", "mov    -0x1c(%rbp),%eax"],
      [119, "3b45d4", "cmp    -0x2c(%rbp),%eax"],
      [122, "7cd2", "jl     0x5555555551f5 <sum+78>"],
      [124, "8b45e0", "mov    -0x20(%rbp),%eax"],
      [127, "488b55f8", "mov    -0x8(%rbp),%rdx"],
      [131, "64482b142528000000", "sub    %fs:0x28,%rdx"],
      [140, "7405", "je     0x55555555523a <sum+147>"],
      [142, "e836feffff", "call   0x555555555070 <__stack_chk_fail@plt>"],
      [147, "c9", "leave"],
      [148, "c3", "ret"],
    ];
    const instructions = code.map(([offset, bytes, instruction]) => ({
      address: `0x${(SUM + offset).toString(16)}`,
      instruction,
      bytes,
    }));
    const h = window.__ipc.handlers;
    const caps = { disassemble: true, instructionStepping: true };
    h.debug_capabilities = () => caps;
    h.debug_disassemble = (args) => {
      const at = instructions.findIndex((i) => BigInt(i.address) === BigInt(args.memoryReference as string));
      const from = Math.max(0, at - (args.before as number));
      return instructions.slice(from, from + (args.count as number));
    };
    h.debug_step_instruction = () => null;
    const frame = (fid: number, name: string, line: number, pc: number) => ({
      id: fid,
      name,
      path: "/proj/main.c",
      line,
      column: 0,
      presentationHint: null,
      instructionPointerReference: `0x${pc.toString(16)}`,
    });
    const debugPath = "/src/features/debugger/state.ts";
    const { adoptSession } = await import(/* @vite-ignore */ debugPath);
    adoptSession(id, {
      adapter: "gdb",
      name: "app-c",
      status: "paused",
      stops: 1,
      caps,
      stoppedThread: 1,
      selectedThread: 1,
      threads: [{ id: 1, name: "main" }],
      frames: [frame(0, "sum", 13, SUM + 78), frame(1, "run", 20, SUM + 109)],
      selectedFrame: 0,
    });
    const dockPath = "/src/workbench/toolwindows/store.ts";
    const layout = await import(/* @vite-ignore */ dockPath);
    layout.moveToolWindow("debug", "bottom");
    layout.setToolWindowSize("bottom", 360);
    layout.showToolWindow("debug", true);
  }, SESSION);

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Disassembly" }).click();
  const grid = debug.getByRole("grid", { name: "Disassembly" });
  const current = grid.locator("[aria-current=location]");
  await expect(current.getByRole("rowheader")).toHaveText("0x00005555555551F5");
  await expect(current.getByRole("gridcell").nth(0)).toHaveText("8B 45 E4");
  await expect(current.getByRole("gridcell").nth(1)).toHaveText("mov    -0x1c(%rbp),%eax");
  expect(await ipcCalls(page, "debug_disassemble")).toEqual([
    { session: SESSION, memoryReference: "0x5555555551f5", before: 32, count: 128 },
  ]);
  // Monospaced columns: every row's instruction starts where the row above starts it.
  const rows = grid.getByRole("row");
  const left = async (row: number) => (await rows.nth(row).getByRole("gridcell").nth(1).boundingBox())!.x;
  expect(await left(5)).toBeCloseTo(await left(4), 0);

  await debug.getByRole("button", { name: "Step Over Instruction" }).click();
  expect(await ipcCalls(page, "debug_step_instruction")).toEqual([{ session: SESSION, threadId: 1, kind: "over" }]);

  // An adapter that cannot step by instruction: the button is disabled and its tooltip says why.
  await page.evaluate(async (id) => {
    const debugPath = "/src/features/debugger/state.ts";
    const { useDebug } = await import(/* @vite-ignore */ debugPath);
    useDebug.setState((st: { sessions: Record<number, object> }) => ({
      sessions: {
        ...st.sessions,
        [id]: { ...st.sessions[id], status: "paused", caps: { disassemble: true, instructionStepping: false } },
      },
    }));
  }, SESSION);
  const stepInto = debug.getByRole("button", { name: "Step Into Instruction" });
  await expect(stepInto).toBeDisabled();
  await stepInto.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText("Instruction stepping is not supported by gdb");
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
