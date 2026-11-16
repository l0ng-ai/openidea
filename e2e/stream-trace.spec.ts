/**
 * Trace Stream Chain on a paused java-debug session: the one chain on the line traces at once, its
 * progress shows while the program runs it, and the result opens as Flat columns and Split pairs.
 * The host is stubbed at the IPC layer; `smoke/debug.test.ts` traces a real JVM.
 */
import { CHAIN_A, CHAIN_A_READY } from "../src/features/debugger/__tests__/streamChainA";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/build.gradle.kts`;
const SESSION = 3;

declare global {
  interface Window {
    finishTrace?: () => void;
  }
}

test("traces the stream chain on the paused line into Flat and Split views", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ file, root, session, chain, ready }) => {
      const h = window.__ipc.handlers;
      const debug = (event: Record<string, unknown>) => window.__ipc.emit({ type: "debug", session, event });
      const stopAt = (line: number, reason: string) => {
        h.debug_stack_trace = () => [
          { id: 11, name: "Main.main", path: file, line, column: 0, presentationHint: null },
        ];
        debug({ kind: "stopped", threadId: 1, reason, description: null, allThreadsStopped: false });
      };
      h.debug_capabilities = () => ({
        restartFrame: false,
        stepInTargets: false,
        functionBreakpoints: false,
        dataBreakpoints: false,
        setValue: false,
        conditionalBreakpoints: true,
        hitConditionalBreakpoints: true,
        logPoints: true,
        hotCodeReplace: false,
        jvmMemory: true,
        jvmInstances: true,
        jvmHeap: false,
        jsPage: false,
        liveEvaluate: false,
        streamTrace: true,
      });
      h.debug_start = () => {
        setTimeout(() => {
          debug({ kind: "started", name: "app", adapter: "java-debug", parent: null });
          debug({ kind: "initialized" });
          stopAt(6, "breakpoint");
        }, 50);
        return session;
      };
      h.debug_threads = () => [{ id: 1, name: "main" }];
      h.debug_scopes = () => [];
      h.debug_stream_chains = () => [chain];
      // The host runs the terminal operation, then steps out of it; the reply waits for `finishTrace`.
      h.debug_stream_trace = (args) => {
        debug({ kind: "continued", threadId: 1, allThreadsContinued: false });
        window.__ipc.send(args.onProgress, { phase: "arming", records: 0, dropped: 0, elapsedMs: 0 });
        window.__ipc.send(args.onProgress, { phase: "running", records: 24, dropped: 0, elapsedMs: 1400 });
        return new Promise((resolve) => {
          window.finishTrace = () => {
            stopAt(6, "step");
            resolve(ready);
          };
        });
      };
      // Launching a Java configuration needs jdtls and a build; attaching goes straight to `debug_start`.
      const stateModule = "/src/features/debugger/state.ts";
      const { startSession } = await import(/* @vite-ignore */ stateModule);
      await startSession({
        name: "app",
        adapter: "java-debug",
        request: "attach",
        program: null,
        args: [],
        cwd: root,
        env: {},
        extraJson: JSON.stringify({ hostName: "localhost", port: 5005 }),
      });
    },
    { file: FILE, root: ROOT, session: SESSION, chain: CHAIN_A, ready: CHAIN_A_READY },
  );

  const debugWindow = page.getByRole("region", { name: "Debug", exact: true });
  await expect(debugWindow.getByText("Main.main", { exact: true })).toBeVisible();

  await page.keyboard.press("Meta+Shift+A");
  const search = page.getByRole("dialog", { name: "Search Everywhere", exact: true });
  await search.getByRole("combobox").fill("Trace Stream Chain");
  await expect(search.getByRole("option", { name: /Trace Stream Chain/ })).toBeVisible();
  await search.getByRole("combobox").press("Enter");
  await expect(search).toBeHidden();

  const tab = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "Stream Trace" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("progressbar", { name: "Tracing the stream chain" })).toBeVisible();
  await expect(page.getByText("24 records · 1 s", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Recording" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Abort Operation…" })).toBeEnabled();

  expect(await ipcCalls(page, "debug_stream_chains")).toEqual([
    { session: SESSION, frame: expect.objectContaining({ id: 11, line: 6 }), top: true },
  ]);
  expect(await ipcCalls(page, "debug_stream_trace")).toEqual([
    expect.objectContaining({
      session: SESSION,
      threadId: 1,
      frame: expect.objectContaining({ id: 11 }),
      chainIndex: 0,
      range: CHAIN_A.range,
    }),
  ]);

  await page.evaluate(() => window.finishTrace?.());
  await expect(page.getByRole("progressbar", { name: "Tracing the stream chain" })).toBeHidden();
  const columns = page.locator('[data-testid="stream-trace-column"]');
  await expect(columns).toHaveCount(5);
  expect(await columns.evaluateAll((cs) => cs.map((c) => c.querySelectorAll("li").length))).toEqual([8, 4, 4, 4, 4]);
  await expect(page.locator('[data-testid="stream-trace-result"]').getByRole("list", { name: "Result" })).toBeVisible();
  // The step-out stop that ends the trace must not bring the source tab back over the result.
  await expect.poll(async () => (await ipcCalls(page, "debug_stack_trace")).length).toBeGreaterThanOrEqual(2);
  await expect(debugWindow.getByText("Main.main", { exact: true })).toBeVisible();
  await expect(tab).toHaveAttribute("aria-selected", "true");

  const third = columns.nth(2);
  await third.getByRole("button", { name: "81", exact: true }).click();
  await expect(third.getByRole("button", { name: "81", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(columns.nth(0).getByRole("button", { name: "8", exact: true })).toHaveAttribute("data-related");

  await page.getByRole("tablist", { name: "Stream trace view" }).getByRole("tab", { name: "Split" }).click();
  await expect(columns).toHaveCount(2);
  await expect(page.locator('[data-testid="stream-trace-result"]')).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Steps" }).getByRole("tab")).toHaveCount(4);
});
