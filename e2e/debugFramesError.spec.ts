import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("shows why the frames did not load and retries them", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 940, height: 740 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const stateModule = "/src/features/debugger/state.ts";
    const workbenchModule = "/src/workbench/contributions.ts";
    const { adoptSession, handleDebugEvent } = await import(/* @vite-ignore */ stateModule);
    const { toolWindowService } = await import(/* @vite-ignore */ workbenchModule);
    const handlers = window.__ipc.handlers;
    let failures = 1;
    handlers.debug_stack_trace = () => {
      if (failures-- > 0)
        throw { kind: "protocol", message: "debug adapter did not answer `stackTrace` in time", detail: null };
      return [{ id: 7, name: "OrderController.place(Order)", path: null, line: 41, column: 0, presentationHint: null }];
    };
    handlers.debug_threads = () => [{ id: 9, name: "http-nio-8080-exec-9" }];
    handlers.debug_scopes = () => [];
    adoptSession(98, { name: "Orders", adapter: "java-debug", status: "running" });
    toolWindowService().show("debug", true);
    handleDebugEvent(98, {
      kind: "stopped",
      threadId: 9,
      allThreadsStopped: false,
      reason: "breakpoint",
      description: null,
    });
  });

  const frames = page.getByRole("region", { name: "Debug", exact: true }).getByRole("listbox", { name: "Frames" });
  const error = frames.getByRole("alert");
  await expect(error).toContainText("Could not load the frames: debug adapter did not answer `stackTrace` in time");
  await page.screenshot({ path: test.info().outputPath("frames-error.png") });
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(frames.getByText("OrderController.place(Order)", { exact: true })).toBeVisible();
  await expect(error).toBeHidden();
  expect(await ipcCalls(page, "debug_stack_trace")).toEqual([
    { session: 98, threadId: 9 },
    { session: 98, threadId: 9 },
  ]);
});
