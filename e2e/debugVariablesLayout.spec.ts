import { expect, stubDesktop, test } from "./fixtures";

const amountName = "regionalSettlementAmountFromExternalProcessorBeforeRounding";
const routingName = "settlementRoutingReferenceForCrossBorderReconciliation";
const routingText = "APR-2026 / eu-west / batch-701 / settlement complete";
const routingValue = "'" + routingText + "'";
const invalidValueMessage = "The settlement amount must be a valid decimal expression.";

test.beforeEach(async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1220, height: 760 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ amountName, routingName, routingValue, invalidValueMessage }) => {
      const debugModule = "/src/features/debugger/state.ts";
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const servicesModule = "/src/workbench/contributions.ts";
      const { adoptSession } = await import(/* @vite-ignore */ debugModule);
      const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
      const { toolWindowService } = await import(/* @vite-ignore */ servicesModule);
      const h = window.__ipc.handlers;
      let amountValue = "47.74";
      const amount = () => ({
        name: amountName,
        value: amountValue,
        typeName: "float",
        variablesReference: 0,
        evaluateName: amountName,
      });
      h.debug_scopes = () => [{ name: "Locals", variablesReference: 100, expensive: false }];
      h.debug_variables = () => [
        amount(),
        { name: routingName, value: routingValue, typeName: "str", variablesReference: 0, evaluateName: routingName },
      ];
      h.debug_set_variable = ({ value }) => {
        if (value === "invalid") throw { kind: "invalid", message: invalidValueMessage, detail: null };
        amountValue = String(value);
        return amount();
      };
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
    { amountName, routingName, routingValue, invalidValueMessage },
  );

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Threads & Variables", exact: true }).click();
});

test("keeps values and their full-value action readable in a narrow debugger", async ({ workbench: page }) => {
  const debug = page.getByRole("region", { name: "Debug", exact: true });
  const amount = debug.getByText("47.74", { exact: true });
  await expect
    .poll(() => amount.evaluate((el) => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  const routing = debug.getByRole("treeitem").filter({ hasText: routingName });
  const show = routing.getByTitle("Show", { exact: true });
  await expect(show).toBeInViewport({ ratio: 1 });
  await show.click();
  const dialog = page.getByRole("dialog", { name: `Value of ${routingName}` });
  await expect(dialog.getByText(routingText, { exact: true })).toBeVisible();
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

test("keeps the variable label and input in place when editing a value", async ({ workbench: page }) => {
  const debug = page.getByRole("region", { name: "Debug", exact: true });
  const row = debug.getByRole("treeitem").filter({ hasText: amountName });
  const name = row.getByText(amountName, { exact: true });
  await row.click();
  const nameBefore = (await name.boundingBox())!;
  const equal = row.getByText("=", { exact: true });
  const equalBefore = (await equal.boundingBox())!;
  const color = await name.evaluate((el) => getComputedStyle(el).color);

  await page.keyboard.press("F2");
  const input = row.getByRole("textbox", { name: `New value of ${amountName}` });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("47.74");
  await expect(name).toHaveCSS("color", color);
  expect((await name.boundingBox())!.x).toBeCloseTo(nameBefore.x, 0);
  expect((await equal.boundingBox())!.x).toBeCloseTo(equalBefore.x, 0);
  await expect(row.locator("svg")).toHaveCount(1);

  await input.fill("invalid");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("title", invalidValueMessage);
  await expect(input).toBeInViewport({ ratio: 1 });
  expect((await input.boundingBox())!.width).toBeGreaterThan(60);
  expect((await equal.boundingBox())!.x).toBeCloseTo(equalBefore.x, 0);

  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(row).toContainText("47.74");

  await page.keyboard.press("F2");
  await expect(input).toHaveValue("47.74");
  await input.fill("48.25");
  await input.press("Enter");
  await expect(input).toBeHidden();
  await expect(row).toContainText("48.25");
});
