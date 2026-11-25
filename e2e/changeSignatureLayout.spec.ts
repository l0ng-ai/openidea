import type { MethodSignature } from "../src/bindings";
import { expect, stubDesktop, test } from "./fixtures";

const signature: MethodSignature = {
  methodIdentifier: "invoice",
  modifier: "",
  returnType: "Invoice",
  methodName: "prepareInvoiceForInternationalSettlement",
  parameters: [
    ["Order", "order"],
    ["String", "billingCurrency"],
    ["BigDecimal", "amountBeforeDiscount"],
    ["Map<String, BigDecimal>", "taxRatesByJurisdiction"],
    ["List<Adjustment>", "settlementAdjustments"],
    ["RoundingMode", "roundingMode"],
    ["LocalDate", "scheduledSettlementDate"],
    ["boolean", "includeTaxBreakdown"],
  ].map(([type, name], originalIndex) => ({ type: type!, name: name!, originalIndex, defaultValue: "" })),
  exceptions: [],
};

test("keeps parameter rows and a long signature preview usable in a short dialog", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 490, height: 520 });
  await page.evaluate(async () => {
    const workbench = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ workbench);
    await editorService().openFile("/dev/acme-api/InvoiceService.java");
  });
  const editor = page.locator(".cm-editor .cm-content");
  await expect(editor).toBeVisible();
  await stubDesktop(page);
  const fontSize = await editor.evaluate(async (content, signature) => {
    window.__ipc.handlers.lsp_signature_info = () => signature;
    const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
    const prefsModule = "/src/editor/core/cm/prefs.ts";
    const { EditorView } = await import(/* @vite-ignore */ viewModule);
    const { stepFontZoom } = await import(/* @vite-ignore */ prefsModule);
    const base = Number.parseFloat(getComputedStyle(content).fontSize);
    const view = EditorView.findFromDOM(content as HTMLElement)!;
    stepFontZoom(view, 4);
    view.focus();
    return `${base + 4}px`;
  }, signature);
  await expect(editor).toHaveCSS("font-size", fontSize);
  await page.keyboard.press("Meta+F6");

  const dialog = page.getByRole("dialog", { name: "Change Signature" });
  const table = dialog.getByRole("table", { name: "Parameters" });
  const names = table.getByRole("textbox", { name: "Name", exact: true });
  await expect(names.first()).toBeInViewport({ ratio: 1 });
  const defaults = table.getByRole("columnheader", { name: "Default value", exact: true });
  await expect(defaults).toHaveCount(0);
  const preview = dialog.locator("pre");
  await expect(preview).toBeInViewport({ ratio: 1 });
  await expect(preview).toHaveCSS("font-size", fontSize);
  await expect(names.first()).toHaveCSS("font-size", fontSize);
  expect(
    await preview.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });

  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(defaults).toBeInViewport({ ratio: 1 });
  const addedType = table.getByRole("textbox", { name: "Type", exact: true }).last();
  await expect(addedType).toBeInViewport({ ratio: 1 });
  await addedType.fill("boolean");
  await names.last().fill("attachReceipt");
  await table.getByRole("textbox", { name: "Default value", exact: true }).last().fill("false");
  await dialog.getByRole("button", { name: "Move Up", exact: true }).click();
  await expect(names.nth(7)).toHaveValue("attachReceipt");
  await expect(preview).toContainText("boolean attachReceipt");
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
