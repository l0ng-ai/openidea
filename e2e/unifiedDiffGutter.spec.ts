import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openDiff(page: Page, left: string, right: string, options: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ left, right, options }) => {
      localStorage.setItem(
        "openidea.vcs.diffOptions",
        JSON.stringify({ mode: "unified", collapse: false, ...options }),
      );
      const actions = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction("diff.compareTexts", {
        path: "SettlementRules.txt",
        left: { text: left, label: "Original" },
        right: { text: right, label: "Modified" },
      });
    },
    { left, right, options },
  );
  return page.getByRole("toolbar", { name: "Diff" });
}

async function rowNumbers(page: Page, text: string, deleted = false) {
  return page
    .locator(deleted ? ".cm-deletedLine" : ".cm-line")
    .filter({ hasText: text })
    .evaluate((row) => {
      const top = row.getBoundingClientRect().top;
      const editor = row.closest(".cm-editor")!;
      const read = (side: string) =>
        [...editor.querySelectorAll(`.cm-diffNumbers-${side} :is(.cm-gutterElement, .cm-diffWidgetNumber)`)].find(
          (number) =>
            getComputedStyle(number).visibility === "visible" && Math.abs(number.getBoundingClientRect().top - top) < 1,
        )?.textContent ?? null;
      return [read("original"), read("modified")];
    });
}

test("Unified Diff keeps original and modified numbers aligned with wrapped and removed lines", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  const oldRule = "Obsolete settlement rule " + "requires review for each exceptional invoice. ".repeat(3);
  const toolbar = await openDiff(
    page,
    ["Settlement rules", oldRule, "Retire legacy routing", "Report totals", "Finish batch"].join("\n"),
    ["Settlement rules", "Validate settlement currency", "Report totals", "Finish batch"].join("\n"),
    { softWrap: true },
  );
  await expect(toolbar).toContainText("1 difference");

  for (const width of [1000, 440]) {
    await page.setViewportSize({ width, height: 640 });
    await expect.poll(() => rowNumbers(page, "Obsolete settlement rule", true)).toEqual(["2", null]);
    await expect.poll(() => rowNumbers(page, "Retire legacy routing", true)).toEqual(["3", null]);
    await expect.poll(() => rowNumbers(page, "Validate settlement currency")).toEqual([null, "2"]);
    await expect.poll(() => rowNumbers(page, "Report totals")).toEqual(["4", "3"]);
  }

  const removed = page.locator(".cm-deletedLine").filter({ hasText: "Obsolete settlement rule" });
  const lineHeight = await removed.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect((await removed.boundingBox())!.height).toBeGreaterThan(lineHeight * 2);
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(toolbar).toContainText("1 of 1 differences");
});

test("Unified Diff numbers account for ignored empty lines and a removal at EOF without a newline", async ({
  workbench: page,
}) => {
  await openDiff(
    page,
    "Settlement rules\n\nReport totals\nFinish batch\nRemove final rule",
    "Settlement rules\nReport totals\nFinish batch",
    { ignore: "whitespaceAndLines" },
  );
  await expect.poll(() => rowNumbers(page, "Report totals")).toEqual(["3", "2"]);
  await expect.poll(() => rowNumbers(page, "Finish batch")).toEqual(["4", "3"]);
  await expect.poll(() => rowNumbers(page, "Remove final rule", true)).toEqual(["5", null]);
});

test("Unified Diff follows vertical scrolling inside one large removal", async ({ workbench: page }) => {
  const removed = Array.from({ length: 250 }, (_, i) => `Retired workflow ${i + 1}.`);
  await openDiff(page, ["Start batch", ...removed, "Finish batch"].join("\n"), "Start batch\nFinish batch");
  const target = page.locator(".cm-deletedLine").filter({ hasText: "Retired workflow 229." });
  await target.scrollIntoViewIfNeeded();
  await expect.poll(() => rowNumbers(page, "Retired workflow 229.", true)).toEqual(["230", null]);
});
