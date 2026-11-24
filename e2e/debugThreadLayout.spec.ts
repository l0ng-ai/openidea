import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("shows thread states in the compact frames header and switches frames by keyboard", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 940, height: 740 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const stateModule = "/src/features/debugger/state.ts";
    const workbenchModule = "/src/workbench/contributions.ts";
    const { adoptSession } = await import(/* @vite-ignore */ stateModule);
    const { toolWindowService } = await import(/* @vite-ignore */ workbenchModule);
    const frame = (id: number, name: string) => ({
      id,
      name,
      path: null,
      line: 0,
      column: 0,
      presentationHint: null,
    });
    const handlers = window.__ipc.handlers;
    handlers.debug_stack_trace = ({ threadId }) => [frame(Number(threadId) * 10, "writeLedger")];
    handlers.debug_scopes = () => [];
    adoptSession(97, {
      name: "Settlement",
      adapter: "debugpy",
      status: "paused",
      stoppedThread: 1,
      selectedThread: 1,
      stopReason: "breakpoint",
      suspendedThreads: [{ id: 2, reason: "pause", description: null }],
      threads: [
        { id: 1, name: "MainThread" },
        { id: 2, name: "Audit writer" },
        { id: 3, name: "Regional settlement reconciliation worker with a long queue name" },
      ],
      selectedFrame: 10,
      frames: [frame(10, "settle")],
    });
    toolWindowService().show("debug", true);
  });

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  const thread = debug.getByRole("button", { name: "Thread", exact: true });
  await expect(thread).toBeVisible();
  const remainder = await thread.evaluate((button) => button.parentElement!.clientWidth - button.clientWidth);
  expect(remainder).toBeLessThan(12);
  await expect(thread).toHaveAccessibleDescription("MainThread (At breakpoint)");
  const frames = debug.getByRole("listbox", { name: "Frames" });
  await expect(frames.getByText("settle", { exact: true })).toBeVisible();

  await thread.press("ArrowDown");
  const menu = page.getByRole("listbox", { name: "Thread" });
  await expect(menu).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("option", { name: "MainThread At breakpoint" })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Audit writer Suspended" })).toBeVisible();
  await expect(
    menu.getByRole("option", { name: /Regional settlement reconciliation worker .* Running/ }),
  ).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(thread).toHaveAccessibleDescription("Audit writer (Suspended)");
  await expect(frames.getByText("writeLedger", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "debug_stack_trace")).toEqual([{ session: 97, threadId: 2 }]);
});
