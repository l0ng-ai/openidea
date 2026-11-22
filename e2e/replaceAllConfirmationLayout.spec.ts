import type { SearchQuery } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Replace All keeps both values readable and the actions visible", async ({ workbench: page }) => {
  const pattern = `LEGACY_${"MONTH_END_RECONCILIATION_INPUT_".repeat(15)}END`;
  const replacement = `ACTIVE_${"MONTH_END_RECONCILIATION_OUTPUT_".repeat(18)}END`;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1040, height: 700 });
  await stubDesktop(page);
  await page.evaluate((pattern) => {
    window.__ipc.handlers.search_validate = () => null;
    window.__ipc.handlers.search_start = ({ query, onEvent }) => {
      if ((query as SearchQuery).pattern !== pattern) return null;
      setTimeout(() => {
        for (const relPath of ["invoice.txt", "receipt.txt"]) {
          window.__ipc.send(onEvent, {
            type: "file",
            file: {
              path: `/dev/acme-api/${relPath}`,
              relPath,
              matches: [{ line: 0, text: pattern, ranges: [[0, pattern.length]], textOffset: 0 }],
            },
          });
        }
        window.__ipc.send(onEvent, {
          type: "done",
          summary: { files: 2, matches: 2, limitHit: false, cancelled: false, elapsedMs: 1 },
        });
      }, 20);
      return null;
    };
  }, pattern);
  await page.keyboard.press("Meta+Shift+r");
  const popup = page.getByRole("dialog", { name: "Replace in Files", exact: true });
  await popup.getByRole("textbox", { name: "Text to find", exact: true }).fill(pattern);
  const replacementInput = popup.getByRole("textbox", { name: "Replace with", exact: true });
  await replacementInput.fill(replacement);
  await expect(popup.getByRole("listbox", { name: "Matches" }).getByRole("option")).toHaveCount(2);
  await page.setViewportSize({ width: 440, height: 520 });
  await popup.getByRole("button", { name: "Replace All", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Replace All", exact: true });
  const findText = dialog.getByRole("region", { name: "Text to find", exact: true });
  const replaceText = dialog.getByRole("region", { name: "Replace with", exact: true });
  const replace = dialog.getByRole("button", { name: "Replace", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(findText).toHaveText(pattern);
  await expect(replaceText).toHaveText(replacement);
  await expect(dialog.getByText("Replace 2 occurrences in 2 files?", { exact: true })).toBeVisible();
  const bottom = (await replace.boundingBox())!.y;
  for (const item of [findText, replaceText]) {
    await expect(item).toHaveCSS("font-size", "13px");
    expect(await item.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollWidth === el.clientWidth)).toBe(
      true,
    );
    await item.focus();
    await page.keyboard.press("End");
    await expect.poll(() => item.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  }
  expect((await replace.boundingBox())!.y).toBeCloseTo(bottom, 0);
  await expect(replace).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await cancel.click();
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 1040, height: 700 });
  await replacementInput.fill("");
  await popup.getByRole("button", { name: "Open in Find Window", exact: true }).click();
  const findWindow = page.getByRole("region", { name: "Find", exact: true });
  await findWindow.getByRole("button", { name: "Replace All", exact: true }).click();
  await expect(findText).toHaveText(pattern);
  await expect(replaceText).toHaveText("Empty text");
  await cancel.click();
  expect(await ipcCalls(page, "replace_in_files")).toHaveLength(0);
});
