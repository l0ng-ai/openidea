import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function setEditorMetrics(page: Page, fontSize: number, lineHeight: number) {
  await page.evaluate(
    async ({ fontSize, lineHeight }) => {
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      const { settings, project } = useProject.getState();
      const current = settings ?? project?.settings;
      if (!current) throw new Error("Expected project settings");
      useProject.setState({ settings: { ...current, editor: { ...current.editor, fontSize, lineHeight } } });
    },
    { fontSize, lineHeight },
  );
}

async function openResults(page: Page) {
  await page.setViewportSize({ width: 1120, height: 720 });
  await stubDesktop(page);
  await setEditorMetrics(page, 20, 34);
  await page.evaluate(async () => {
    const lines = Array.from({ length: 1240 }, () => "");
    lines[1233] = "  record(orderTotal);";
    lines[1237] = "  return orderTotal;";
    window.__ipc.handlers.fs_read_text = () => lines.join("\n");
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("find.showUsageResults", {
      symbol: "orderTotal",
      locations: [
        {
          path: "/dev/acme-api/src/orderTotals.ts",
          range: { start: { line: 1233, col: 9 }, end: { line: 1233, col: 19 } },
        },
        {
          path: "/dev/acme-api/src/orderTotals.ts",
          range: { start: { line: 1237, col: 9 }, end: { line: 1237, col: 19 } },
        },
      ],
    });
  });
  const view = page.getByRole("region", { name: "Find Usages", exact: true });
  await view.getByRole("treeitem").filter({ hasText: "1234" }).click();
  const preview = view.getByRole("region", { name: "Preview", exact: true });
  await expect(preview.locator("mark")).toHaveCount(2);
  return { view, preview };
}

test("Find Usages preview follows editor line height and fits long line numbers", async ({ workbench: page }) => {
  const { preview } = await openResults(page);
  await expect(preview).toHaveCSS("font-size", "20px");
  await expect(preview).toHaveCSS("line-height", "34px");

  const number = preview.getByText("1234", { exact: true });
  const gutter = await number.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { textInset: text.left - box.left, width: box.width };
  });
  expect(gutter.textInset).toBeGreaterThanOrEqual(1);
  await expect(number).toBeInViewport({ ratio: 0.98 });
  expect((await preview.getByText("999", { exact: true }).boundingBox())!.width).toBeCloseTo(gutter.width, 0);

  await page.setViewportSize({ width: 560, height: 720 });
  await setEditorMetrics(page, 20, 39);
  await expect(preview).toHaveCSS("line-height", "39px");
  await expect(number).toBeInViewport({ ratio: 0.98 });
});

test("Find Usages starts with equal panes and keeps a separate saved size for each orientation", async ({
  workbench: page,
}) => {
  const { view } = await openResults(page);
  const divider = view.locator('[id="usages-preview-split"]').getByRole("separator");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await divider.press("ArrowRight");
  await expect(divider).not.toHaveAttribute("aria-valuenow", "50");
  const horizontal = (await divider.getAttribute("aria-valuenow"))!;

  await page.setViewportSize({ width: 560, height: 720 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await divider.press("ArrowDown");
  await expect(divider).not.toHaveAttribute("aria-valuenow", "50");
  const vertical = (await divider.getAttribute("aria-valuenow"))!;

  await page.setViewportSize({ width: 1120, height: 720 });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider).toHaveAttribute("aria-valuenow", horizontal);
  await page.setViewportSize({ width: 560, height: 720 });
  await expect(divider).toHaveAttribute("aria-valuenow", vertical);
});
