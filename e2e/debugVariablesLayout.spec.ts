import { expect, stubDesktop, test } from "./fixtures";

const amountName = "regionalSettlementAmountFromExternalProcessorBeforeRounding";
const routingName = "settlementRoutingReferenceForCrossBorderReconciliation";
const routingValue = "'APR-2026 / eu-west / batch-701 / settlement complete'";

test("keeps values and their full-value action readable in a narrow debugger", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1220, height: 760 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ amountName, routingName, routingValue }) => {
      const debugModule = "/src/features/debugger/state.ts";
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const servicesModule = "/src/workbench/contributions.ts";
      const { adoptSession } = await import(/* @vite-ignore */ debugModule);
      const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
      const { toolWindowService } = await import(/* @vite-ignore */ servicesModule);
      const h = window.__ipc.handlers;
      h.debug_scopes = () => [{ name: "Locals", variablesReference: 100, expensive: false }];
      h.debug_variables = () => [
        { name: amountName, value: "47.74", typeName: "float", variablesReference: 0, evaluateName: amountName },
        { name: routingName, value: routingValue, typeName: "str", variablesReference: 0, evaluateName: routingName },
      ];
      adoptSession(91, {
        name: "Checkout",
        adapter: "debugpy",
        status: "paused",
        selectedFrame: 11,
        frames: [{ id: 11, name: "checkout", path: null, line: 0, column: 0, presentationHint: null }],
      });
      moveToolWindow("debug", "right");
      setToolWindowSize("right", 390);
      toolWindowService().show("debug", true);
    },
    { amountName, routingName, routingValue },
  );

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Threads & Variables", exact: true }).click();
  const amount = debug.getByText("47.74", { exact: true });
  await expect
    .poll(() => amount.evaluate((el) => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  const routing = debug.getByRole("treeitem").filter({ hasText: routingName });
  const show = routing.getByTitle("Show", { exact: true });
  await expect(show).toBeInViewport({ ratio: 1 });
  await show.click();
  const dialog = page.getByRole("dialog", { name: `Value of ${routingName}` });
  await expect(dialog.getByText(routingValue, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 1640, height: 760 });
  await page.evaluate(async () => {
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const { moveToolWindow } = await import(/* @vite-ignore */ layoutModule);
    moveToolWindow("debug", "bottom");
  });
  await expect(show).toBeHidden();
  await expect
    .poll(() => routing.getByText(routingValue, { exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
});
