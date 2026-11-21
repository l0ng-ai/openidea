import { expect, stubDesktop, test } from "./fixtures";

test("selects an existing test first and places the creation action after the results", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 500, height: 540 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendPath);
    const { editorService } = await import(/* @vite-ignore */ contributionsPath);
    const files = new Map([
      ["/dev/acme-api/src/Checkout.ts", "export const checkout = 'source';"],
      ["/dev/acme-api/src/Checkout.js", "export const checkout = 'alternate source';"],
      ["/dev/acme-api/tests/enterprise/orders/reconciliation/merchant/Checkout.test.ts", "const suite = 'merchant';"],
      ["/dev/acme-api/tests/enterprise/orders/reconciliation/guest/Checkout.test.ts", "const suite = 'guest';"],
    ]);
    for (const [path, text] of files) docBackend().files.set(path, text);
    window.__ipc.handlers.find_files = ({ query }) =>
      [...files.keys()].filter((path) => path.endsWith(`/${query}`)).map((path) => ({ path }));
    window.__ipc.handlers.fs_probe = () => ({ binary: false, tooLarge: false });
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    await editorService().openFile("/dev/acme-api/src/Checkout.ts", { focus: true });
  });
  const editor = page.locator(".cm-content").last();
  await expect(editor).toContainText("source");
  await editor.press("Meta+Shift+t");

  const tests = page.getByRole("dialog", { name: "Choose Test for Checkout (2 found)" });
  const list = tests.getByRole("listbox");
  const first = list.getByRole("option", { selected: true });
  const create = list.getByRole("option", { name: "Create New Test…", exact: true });
  await expect(first).toContainText("Checkout.test.ts");
  await expect(first.getByText("Checkout.test.ts", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(first.locator('[title="tests/enterprise/orders/reconciliation/guest"]')).toHaveCSS("font-size", "13px");
  await expect(list.getByRole("option").last()).toHaveText("Create New Test…");

  await list.press("Enter");
  await expect(editor).toContainText("guest");
  await editor.press("Meta+Shift+t");
  const subjects = page.getByRole("dialog", { name: "Choose Test Subject for Checkout.test (2 found)" });
  await expect(subjects.getByRole("option", { selected: true })).toContainText("Checkout.js");
  await subjects.getByRole("listbox").press("End");
  await subjects.getByRole("listbox").press("Enter");
  await expect(editor).toContainText("checkout = 'source'");

  await editor.press("Meta+Shift+t");
  await list.press("End");
  await expect(create).toHaveAttribute("aria-selected", "true");
  await list.press("Enter");
  const form = page.getByRole("dialog", { name: "New TypeScript File", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByRole("option", { name: "Test", exact: true, selected: true })).toBeVisible();
});
