import { expect, openFromTree, stubDesktop, test } from "./fixtures";

test("File Structure keeps symbol filters readable at desktop and minimum window widths", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const range = { start: { line: 0, col: 0 }, end: { line: 1, col: 1 } };
    const field = {
      name: "orderCount",
      kind: "field",
      visibility: "private",
      range,
      selection_range: range,
      children: [],
    };
    window.__ipc.handlers.doc_outline = () => [
      { name: "OrderController", kind: "class", range, selection_range: range, children: [field] },
    ];
    window.__ipc.handlers.lsp_type_hierarchy = () => [];
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction("navigate.fileStructure");
  });

  const dialog = page.getByRole("dialog", { name: "File Structure" });
  const fields = dialog.getByRole("checkbox", { name: "Show fields" });
  await expect(dialog.getByRole("checkbox", { name: "Show inherited members" })).toBeVisible();
  for (const width of [400, 1000]) {
    await page.setViewportSize({ width, height: 600 });
    const clipped = await dialog.evaluate((element) => {
      const labels = [...element.querySelectorAll("label")].filter((label) =>
        label.querySelector('input[type="checkbox"]'),
      );
      const row = labels[0]!.parentElement!.getBoundingClientRect();
      return labels.flatMap((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        const box = range.getBoundingClientRect();
        return box.top < row.top - 1 || box.right > row.right + 1 || box.bottom > row.bottom + 1
          ? [label.textContent]
          : [];
      });
    });
    expect(clipped).toEqual([]);
  }
  // The dialog scales in when it opens: wait for its settled width.
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(540);
  const field = dialog.getByRole("treeitem", { name: "orderCount" });
  await expect(field).toBeVisible();
  await fields.uncheck();
  await expect(field).toBeHidden();
});
