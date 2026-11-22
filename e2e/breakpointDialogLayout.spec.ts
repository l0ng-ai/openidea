import { expect, test } from "./fixtures";

test("keeps breakpoint details editable when the dialog gets narrow", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 500, height: 480 });
  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const storeModule = "/src/features/debugger/breakpoints/store.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    const { addBreakpoint } = await import(/* @vite-ignore */ storeModule);
    addBreakpoint("/dev/acme-api/CheckInternationalSettlementBeforeDispatch.java", 7, {
      condition: "amount > 100",
    });
    addBreakpoint("/dev/acme-api/Receipt.java", 4);
    await executeAction("debug.viewBreakpoints");
  });

  const dialog = page.getByRole("dialog", { name: "Breakpoints" });
  const list = dialog.getByRole("listbox", { name: "All breakpoints" });
  const condition = dialog.locator('input[aria-label="Condition"]');
  await expect(condition).toHaveValue("amount > 100");
  const actions = dialog.getByRole("group", { name: "Actions", exact: true });
  await expect(actions).toBeVisible();
  await expect(dialog.getByText("Condition", { exact: true })).toHaveCSS("font-size", "13px");
  await expect(dialog.getByText("Hit count", { exact: true })).toHaveCSS("font-size", "13px");
  await expect.poll(async () => (await condition.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(240);
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport({ ratio: 1 });
  await condition.fill("amount > 250");
  await actions.getByRole("checkbox", { name: '"Breakpoint hit" message', exact: true }).check();
  await actions.getByRole("checkbox", { name: "Evaluate and log", exact: true }).check();
  const log = actions.getByRole("textbox", { name: "Evaluate and log", exact: true });
  await log.fill("total: {amount}");
  const temporary = actions.getByRole("checkbox", { name: "Remove once hit", exact: true });
  await temporary.check();
  const first = list.getByRole("option", { name: /CheckInternationalSettlementBeforeDispatch\.java:8/ });
  await expect(first.getByText(":8", { exact: true })).toBeInViewport({ ratio: 1 });
  await list.getByRole("option", { name: /Receipt\.java:5/ }).click();
  await expect(condition).toHaveValue("");
  await first.click();
  await expect(condition).toHaveValue("amount > 250");
  await expect(log).toHaveValue("total: {amount}");
  await expect(temporary).toBeChecked();

  await page.setViewportSize({ width: 1080, height: 760 });
  const divider = dialog.locator('[data-separator][aria-orientation="vertical"]');
  await expect(divider).toBeInViewport();
  const oldWidth = (await list.boundingBox())!.width;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeGreaterThan(oldWidth + 20);
  await expect(condition).toHaveValue("amount > 250");
  const request = dialog.getByRole("textbox", { name: "Part of a request URL" });
  await request.scrollIntoViewIfNeeded();
  await expect(request).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
});
