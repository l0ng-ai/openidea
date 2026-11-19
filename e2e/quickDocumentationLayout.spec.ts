import type { Page } from "@playwright/test";
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

async function quickDocumentation(page: Page, markdown: string) {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate((value) => {
    window.__ipc.handlers.lsp_hover = () => ({ contents: { kind: "markdown", value }, range: null });
  }, markdown);
  const line = editor.locator(".cm-line", { hasText: "return order.toDto()" });
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("F1");
  const popup = page.getByRole("dialog", { name: "Documentation", exact: true });
  await expect(popup.locator(".cm-lsp-markdown")).toBeVisible();
  return popup;
}

test("short quick documentation uses a readable width and a compact corner of actions", async ({ workbench: page }) => {
  const popup = await quickDocumentation(page, "Returns the total.");
  const back = popup.getByRole("button", { name: "Back", exact: true });
  const dock = popup.getByRole("button", { name: "Show in Documentation Tool Window" });
  await expect(dock).toBeVisible();
  const bounds = (await popup.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(298);
  expect(bounds.width).toBeLessThan(320);
  const backBounds = (await back.boundingBox())!;
  const dockBounds = (await dock.boundingBox())!;
  expect(backBounds.x).toBeGreaterThan(bounds.x + bounds.width / 2);
  expect(bounds.x + bounds.width - dockBounds.x - dockBounds.width).toBeLessThan(16);
  await expect(popup.locator(".cm-lsp-markdown")).toHaveCSS("font-size", "13px");
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});

test("long quick documentation scrolls with its actions in view", async ({ workbench: page }) => {
  const signature = "fun calculateTotal(order: Order, options: ExtendedPricingOptions): CalculationResult";
  const markdown = [
    `\`\`\`kotlin\n${signature}\n\`\`\``,
    ...Array.from({ length: 22 }, (_, i) => {
      return `Section ${i + 1}. Explains the applicable pricing rules, shipping restrictions and currency options.`;
    }),
    "End of pricing documentation.",
  ].join("\n\n");
  const popup = await quickDocumentation(page, markdown);
  const dock = popup.getByRole("button", { name: "Show in Documentation Tool Window" });
  await expect(dock).toBeVisible();
  expect((await popup.boundingBox())!.width).toBeLessThan(508);
  await page.setViewportSize({ width: 430, height: 500 });
  await expect
    .poll(async () => {
      const box = (await popup.boundingBox())!;
      return Math.max(-box.x, -box.y, box.x + box.width - 430, box.y + box.height - 500);
    })
    .toBeLessThanOrEqual(1);
  const body = popup.locator(".cm-lsp-markdown").locator("..");
  const last = popup.getByText("End of pricing documentation.");
  const dockBefore = (await dock.boundingBox())!;
  await expect(body.locator("pre")).toContainText(signature);
  const scroll = await body.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return { top: node.scrollTop, horizontalOverflow: node.scrollWidth - node.clientWidth };
  });
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.horizontalOverflow).toBeLessThanOrEqual(1);
  const lastBounds = (await last.boundingBox())!;
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(dockBefore.y + 1);
  expect(await dock.boundingBox()).toEqual(dockBefore);
  await expect(dock).toBeInViewport();
});
