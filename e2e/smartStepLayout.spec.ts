import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test.use({ reducedMotion: "reduce" });

const FILE = "/dev/acme-api/build.gradle.kts";
const LINE = 20;
const NAME = "SettlementValidator";
const labels = Array.from(
  { length: 14 },
  (_, index) => `${NAME}.validateSettlement${index + 1}(RegionalSettlementRequest, SettlementLedgerValidationContext)`,
);

test("Smart Step Into anchors to the paused line and keeps long targets selectable", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1280, height: 780 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, line, labels }) => {
      const state = "/src/features/debugger/state.ts";
      const { adoptSession, updateExecutionPoint } = await import(/* @vite-ignore */ state);
      const handlers = window.__ipc.handlers;
      handlers.debug_capabilities = () => ({ stepInTargets: true });
      handlers.debug_step_in_targets = () =>
        labels.map((label, index) => ({ id: index + 1, label, line, column: null, endColumn: null }));
      handlers.debug_step_in_target = () => null;
      adoptSession(93, {
        name: "Settlement",
        adapter: "debugpy",
        status: "paused",
        caps: { stepInTargets: true },
        stoppedThread: 3,
        selectedThread: 3,
        selectedFrame: 20,
        frames: [{ id: 20, name: "settle", path, line, column: 0, presentationHint: null }],
      });
      updateExecutionPoint();
    },
    { path: FILE, line: LINE, labels },
  );
  const choose = async (path: string | null) => {
    await page.evaluate(
      async ({ path, line }) => {
        const state = "/src/features/debugger/state.ts";
        const { useExecutionPoint } = await import(/* @vite-ignore */ state);
        useExecutionPoint.setState({ path, line, top: true });
        const actions = "/src/platform/actions.ts";
        await (await import(/* @vite-ignore */ actions)).executeAction("debug.smartStepInto");
      },
      { path, line: LINE },
    );
  };
  const source = editor.locator(".cm-line", { hasText: "val order: Order" });
  await source.scrollIntoViewIfNeeded();
  await choose(FILE);
  const chooser = page.getByRole("dialog", { name: "Smart Step Into" });
  const list = chooser.getByRole("listbox", { name: "Calls on the current line" });
  await expect(list).toBeFocused();
  const anchor = (await source.boundingBox())!;
  await expect.poll(async () => Math.abs((await chooser.boundingBox())!.x - anchor.x)).toBeLessThan(20);
  const box = (await chooser.boundingBox())!;
  expect(anchor.y - box.y - box.height).toBeGreaterThanOrEqual(0);
  expect(anchor.y - box.y - box.height).toBeLessThan(12);

  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  expect(await ipcCalls(page, "debug_step_in_target")).toEqual([]);
  await choose(null);
  await expect(chooser).toBeVisible();
  const center = (await chooser.boundingBox())!;
  expect(center.x + center.width / 2).toBeCloseTo(640, 0);
  expect(center.y + center.height / 2).toBeCloseTo(390, 0);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 560, height: 460 });
  await source.scrollIntoViewIfNeeded();
  await choose(FILE);
  await expect(chooser).toBeInViewport({ ratio: 1 });
  await expect(list).toBeFocused();
  expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await page.keyboard.press("End");
  const last = list.getByRole("option", { name: labels.at(-1), exact: true });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(chooser).toBeHidden();
  expect(await ipcCalls(page, "debug_step_in_target")).toEqual([{ session: 93, threadId: 3, targetId: 14 }]);
});
