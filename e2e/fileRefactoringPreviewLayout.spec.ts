import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("shows the changed text and file controls in a short, narrow refactoring preview", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 450, height: 500 });
  await stubDesktop(page);
  const first = "/dev/acme-api/docs/customer/orders/checkout/CheckoutGuide.txt";
  const second = "/dev/acme-api/docs/CheckoutTests.txt";
  await page.evaluate(
    async ({ first, second }) => {
      const previous = "pricing.txt";
      const replacement = "billing.txt";
      const text = `const longDescription = "${"checkout ".repeat(24)}"; see "${previous}" for details`;
      const start = text.indexOf(previous);
      window.__ipc.handlers.fs_read_text = () => Array.from({ length: 12 }, () => text).join("\n");
      window.__ipc.handlers.refactor_file_move_text_edits = () => ({
        files: [first, second].map((path, index) => ({
          kind: "edit",
          path,
          version: null,
          edits: Array.from({ length: index === 0 ? 12 : 1 }, (_, line) => ({
            range: { start: { line, col: start }, end: { line, col: start + previous.length } },
            new_text: replacement,
          })),
        })),
      });
      window.__ipc.handlers.refactor_move_files = () => 1;
      const module = "/src/features/project-tree/fileRefactor.ts";
      const { runFileRefactoring } = await import(/* @vite-ignore */ module);
      void runFileRefactoring(
        [{ from: "/dev/acme-api/pricing.txt", to: "/dev/acme-api/billing.txt" }],
        { references: false, textOccurrences: true },
        "Rename",
      );
    },
    { first, second },
  );

  const dialog = page.getByRole("dialog", { name: /Refactoring Preview/ });
  const changes = dialog.getByRole("list", { name: "Changes", exact: true });
  const firstFile = dialog.getByRole("checkbox", { name: "Include CheckoutGuide.txt", exact: true });
  const firstReplacement = changes.locator("ins").first();
  await expect(dialog).toContainText("13 occurrences in 2 files");
  await expect(firstReplacement).toHaveText("billing.txt");
  await expect(firstReplacement).toBeInViewport({ ratio: 1 });
  await expect(firstFile).toBeInViewport({ ratio: 1 });

  const scroller = await changes.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  });
  expect(scroller).toBeGreaterThan(0);
  await expect(dialog.getByText(/References to update/)).toBeInViewport({ ratio: 1 });
  const skip = dialog.getByRole("checkbox", { name: "Include CheckoutTests.txt", exact: true });
  await expect(skip).toBeInViewport({ ratio: 1 });
  await skip.uncheck();
  await expect(dialog).toContainText("12 occurrences in 1 file");
  await dialog.getByRole("button", { name: "Do Refactor", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await ipcCalls(page, "refactor_move_files")).length).toBe(1);
  const [args] = await ipcCalls(page, "refactor_move_files");
  expect(args!.edit).toMatchObject({ files: [{ path: first }] });
});
