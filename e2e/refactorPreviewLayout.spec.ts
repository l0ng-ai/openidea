import { expect, test } from "./fixtures";

test("the workspace refactoring preview separates filenames from directories and keeps outcomes readable", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 420, height: 620 });
  await page.evaluate(async () => {
    const popupPath = "/src/editor/lsp/popupStore.ts";
    const editPath = "/src/editor/lsp/workspaceEdit.ts";
    const { openPopup } = await import(/* @vite-ignore */ popupPath);
    const { summarizeWorkspaceEdit } = await import(/* @vite-ignore */ editPath);
    const root = "/dev/acme-api";
    const edit = {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 9 } },
      new_text: "postInvoice",
    };
    openPopup({
      kind: "preview",
      title: "Rename 'saveOrder' to 'postInvoice'",
      summary: summarizeWorkspaceEdit({
        files: [
          { kind: "edit", path: `${root}/README.md`, edits: [edit] },
          { kind: "edit", path: `${root}/packages/billing/src/Routes.ts`, edits: [edit, edit] },
          { kind: "edit", path: `${root}/packages/checkout/src/Routes.ts`, edits: [edit] },
          {
            kind: "rename",
            from: `${root}/packages/checkout/src/Invoice.ts`,
            to: `${root}/packages/checkout/src/InvoiceReconciliationForInternationalOrders.ts`,
          },
        ],
      }),
      renameThemeClasses: "",
      confirmLabel: "Do Refactor",
      onConfirm: () => {
        document.body.dataset.refactorConfirmed = "true";
      },
    });
  });

  const dialog = page.getByRole("dialog", { name: "Rename 'saveOrder' to 'postInvoice'" });
  const rows = dialog.getByRole("list", { name: "Changes" }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(dialog.getByText("4 occurrences in 4 files")).toBeVisible();
  const root = rows.filter({ hasText: "README.md" });
  await expect(root.getByText("README.md", { exact: true })).toHaveCount(1);

  const billing = rows.filter({ hasText: "2 occurrences" });
  await expect(billing.getByText("Routes.ts", { exact: true })).toBeVisible();
  await expect(billing.getByText("packages/billing/src", { exact: true })).toBeVisible();
  await expect(billing.getByTitle("packages/billing/src/Routes.ts", { exact: true })).toBeVisible();
  const checkout = rows.filter({ hasText: "packages/checkout/src" }).filter({ hasText: "Routes.ts" });
  await expect(checkout.getByText("packages/checkout/src", { exact: true })).toBeVisible();

  const rename = rows.filter({ hasText: "Invoice.ts" });
  const target = rename.getByText("→ InvoiceReconciliationForInternationalOrders.ts", { exact: true });
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("title", "packages/checkout/src/InvoiceReconciliationForInternationalOrders.ts");
  expect((await target.boundingBox())!.width).toBeGreaterThan(35);
  await expect(dialog.getByRole("button", { name: "Do Refactor", exact: true })).toBeInViewport();
  await dialog.getByRole("button", { name: "Do Refactor", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-refactor-confirmed", "true");
});
