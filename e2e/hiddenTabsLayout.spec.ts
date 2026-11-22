import { expect, test } from "./fixtures";

const names = [
  "AccountSummary.ts",
  "BatchSettlement.ts",
  "CurrencyRates.ts",
  "DailyLedgerReport.ts",
  "ExchangeReconciliation.ts",
  "FundingSchedule.ts",
  "GeneralLedger.ts",
  "HistoryExport.ts",
  "InvoicePublisher.ts",
];

test("a pinned editor tab can be unpinned from the hidden tabs list", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 700, height: 650 });
  await page.evaluate(async (first) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ module);
    await editorService().openFile(`/dev/acme-api/${first}`);
  }, names[0]!);
  const strip = page.getByRole("tablist", { name: "Editor tabs" });
  const tab = strip.getByRole("tab", { name: names[0], exact: true });
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin Tab", exact: true }).click();
  await page.evaluate(async (files) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ module);
    for (const name of files) await editorService().openFile(`/dev/acme-api/${name}`);
  }, names.slice(1));
  await strip.evaluate((element) => (element.scrollLeft = element.scrollWidth));
  await page.getByRole("button", { name: "Show Hidden Tabs" }).click();
  const row = page.getByRole("grid", { name: "Hidden Editor Tabs" }).getByRole("row").filter({ hasText: names[0]! });
  await expect(row.getByRole("button", { name: "Close Tab", exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "Unpin Tab", exact: true }).click();
  await expect(tab).toHaveCount(1);
});

test("the editor overflow lists clipped tabs and can close or open one without touching visible tabs", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 900, height: 690 });
  await page.evaluate(async (files) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ module);
    for (const name of files) await editorService().openFile(`/dev/acme-api/${name}`);
  }, names);
  const strip = page.getByRole("tablist", { name: "Editor tabs" });
  const trigger = page.getByRole("button", { name: "Show Hidden Tabs" });
  await expect(trigger).toBeVisible();
  await expect(strip.getByRole("tab", { name: names.at(-1) })).toHaveAttribute("aria-selected", "true");
  await strip.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
  });
  const hidden = await strip.evaluate((element) => {
    const { left, right } = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>("[role=tab]"))
      .filter((tab) => {
        const box = tab.parentElement!.getBoundingClientRect();
        return box.left < left - 1 || box.right > right + 1;
      })
      .map((tab) => tab.innerText);
  });
  expect(hidden).toContain(names[0]);
  expect(hidden).toContain(names.at(-1));
  expect(hidden.length).toBeLessThan(names.length);

  await trigger.click();
  const grid = page.getByRole("grid", { name: "Hidden Editor Tabs" });
  await expect(grid).toBeVisible();
  await expect(grid).toBeInViewport({ ratio: 1 });
  await expect(grid.getByRole("row")).toHaveCount(hidden.length);
  for (const name of names) {
    await expect(grid.getByRole("gridcell", { name, exact: true })).toHaveCount(hidden.includes(name) ? 1 : 0);
  }

  const close = grid.getByRole("row").filter({ hasText: names[0] }).getByRole("button", { name: "Close Tab" });
  await close.click();
  await expect(strip.getByRole("tab", { name: names[0] })).toHaveCount(0);
  await expect(strip.getByRole("tab", { name: names.at(-1) })).toHaveAttribute("aria-selected", "true");
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("rowgroup")).toBeFocused();

  await page.keyboard.press("Home");
  const selected = (await grid.getByRole("row", { selected: true }).getByRole("gridcell").first().innerText()).trim();
  await page.keyboard.press("Enter");
  await expect(grid).toBeHidden();
  const opened = strip.getByRole("tab", { name: selected, exact: true });
  await expect(opened).toHaveAttribute("aria-selected", "true");
  await expect(opened).toBeInViewport({ ratio: 1 });

  await trigger.click();
  await expect(grid).toBeVisible();
  await page.setViewportSize({ width: 2100, height: 690 });
  await expect(grid).toBeHidden();
  await expect(trigger).toBeHidden();
  await page.setViewportSize({ width: 790, height: 690 });
  await expect(trigger).toBeVisible();
  await expect(grid).toBeHidden();
});
