import type { ExtractInterfaceInfo } from "../src/bindings";
import { expect, stubDesktop, test } from "./fixtures";

const info: ExtractInterfaceInfo = {
  className: "InvoiceService",
  packages: [
    { displayName: "com.example.billing", path: "/dev/acme-api", isParentOfSelectedFile: true },
    { displayName: "com.example.billing.api", path: "/dev/acme-api/api" },
  ].map((entry) => JSON.stringify(entry)),
  members: Array.from({ length: 24 }, (_, i) => ({
    name: `prepareInvoiceForInternationalSettlement${i + 1}`,
    parameters: ["BigDecimal", "Map<String, BigDecimal>", "LocalDate", "boolean"],
    typeName: "SettlementInvoice",
    handleIdentifier: `method-${i + 1}`,
  })),
};

test("keeps the interface fields, members and actions usable in a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 470, height: 410 });
  await page.evaluate(async () => {
    const workbench = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ workbench);
    await editorService().openFile("/dev/acme-api/InvoiceService.java", { focus: true });
  });
  const editor = page.locator(".cm-editor .cm-content");
  await expect(editor).toBeVisible();
  await stubDesktop(page);
  await editor.focus();
  await page.evaluate(async (info) => {
    window.__ipc.handlers.lsp_extract_interface_info = () => info;
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("refactor.extractInterface");
  }, info);

  const dialog = page.getByRole("dialog", { name: "Extract Interface" });
  const table = dialog.getByRole("table", { name: "Members to Form Interface" });
  await expect(table.getByRole("row")).toHaveCount(25);
  const source = dialog.getByRole("textbox", { name: "Extract interface from:", exact: true });
  const name = dialog.getByRole("textbox", { name: "Interface name:", exact: true });
  await expect(source).toHaveAttribute("readonly", "");
  await expect(source).toHaveValue("InvoiceService");
  await expect(name).toBeFocused();
  await expect(source).toBeInViewport({ ratio: 1 });
  await name.fill("SettlementInvoicing");

  const body = dialog.locator("[data-dialog-body]");
  const refactor = dialog.getByRole("button", { name: "Refactor", exact: true });
  await expect(refactor).toBeDisabled();
  const last = table.getByRole("checkbox", { name: /^prepareInvoiceForInternationalSettlement24\(/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(table.getByRole("columnheader", { name: "Member" })).toBeInViewport({ ratio: 1 });
  await expect.poll(() => table.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await last.check();
  await expect(refactor).toBeEnabled();
  expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(refactor).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor).toBeFocused();
});
