/**
 * A debugging session: a breakpoint set in the editor reaches the adapter, the session stops there
 * with its frames and variables, and stepping and resuming go back to the adapter. The adapter is
 * stubbed at the IPC layer; `crates/ide-dap/tests` drives real ones.
 */
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
