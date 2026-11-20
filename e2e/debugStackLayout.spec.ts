import { expect, stubDesktop, test } from "./fixtures";

const functionName = "calculateRegionalSettlementFromExternalOrderBeforeReconciliation";
const sourcePath = "/dev/acme-api/build.gradle.kts";

test("keeps frame sources and the keyboard selection visible in a narrow debug dock", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 540 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ functionName, sourcePath }) => {
      const debugModule = "/src/features/debugger/state.ts";
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const servicesModule = "/src/workbench/contributions.ts";
      const { adoptSession } = await import(/* @vite-ignore */ debugModule);
      const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
      const { toolWindowService } = await import(/* @vite-ignore */ servicesModule);
      const workerFrame = {
        id: 51,
        name: "processOrder",
        path: sourcePath,
        line: 5,
        column: 0,
        presentationHint: null,
      };
      window.__ipc.handlers.debug_scopes = () => [];
      window.__ipc.handlers.debug_stack_trace = () => [workerFrame];
      adoptSession(91, {
        name: "Reconciliation",
        adapter: "debugpy",
        status: "paused",
        stoppedThread: 1,
        selectedThread: 1,
        threads: [
          { id: 1, name: "MainThread" },
          { id: 2, name: "Order worker" },
        ],
        selectedFrame: 1,
        frames: Array.from({ length: 32 }, (_, index) => ({
          id: index + 1,
          name: index === 0 ? functionName : index === 1 ? "runBatch" : `reconcile(${index})`,
          path: sourcePath,
          line: index === 0 ? 41 : index,
          column: 0,
          presentationHint: null,
        })),
      });
      moveToolWindow("debug", "right");
      setToolWindowSize("right", 420);
      toolWindowService().show("debug", true);
    },
    { functionName, sourcePath },
  );
  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Threads & Variables", exact: true }).click();
  const thread = debug.getByRole("button", { name: "Thread", exact: true });
  const frames = debug.getByRole("listbox", { name: "Frames", exact: true });
  const first = frames.getByRole("option", { selected: true });
  await expect(first.getByText(functionName, { exact: true })).toBeVisible();
  expect(await frames.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(first.getByText(":42", { exact: true })).toBeInViewport({ ratio: 1 });
  expect(await first.getByText(/build\.gradle\.kts/).evaluate((el) => el.clientWidth)).toBeGreaterThan(25);
  const shortName = frames.getByText("runBatch", { exact: true });
  expect(await shortName.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await frames.focus();
  for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowDown");
  const selected = frames.getByRole("option", { selected: true });
  await expect(selected.getByText("reconcile(25)", { exact: true })).toBeInViewport({ ratio: 0.95 });
  expect(await frames.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await thread.click();
  await page.getByRole("option", { name: "Order worker", exact: true }).click();
  await expect(thread).toContainText("Order worker");
  await expect(frames.getByRole("option", { selected: true })).toContainText("processOrder");
});
