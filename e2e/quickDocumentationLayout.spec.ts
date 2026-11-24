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
  const edit = popup.getByRole("button", { name: "Edit Source" });
  const more = popup.getByRole("button", { name: "More Actions" });
  await expect(edit).toBeVisible();
  await expect(more).toBeVisible();
  await expect(popup.getByRole("button")).toHaveCount(2);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(298);
  expect(bounds.width).toBeLessThan(320);
  const editBounds = (await edit.boundingBox())!;
  const moreBounds = (await more.boundingBox())!;
  expect(editBounds.x).toBeGreaterThan(bounds.x + bounds.width / 2);
  expect(bounds.x + bounds.width - moreBounds.x - moreBounds.width).toBeLessThan(16);
  await expect(popup.locator(".cm-lsp-markdown")).toHaveCSS("font-size", "13px");
  await more.press("Enter");
  const menu = page.getByRole("menu", { name: "More Actions" });
  const dock = menu.getByRole("menuitem", { name: "Show in Documentation Tool Window" });
  await expect(dock).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Back" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Forward" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(popup).toBeVisible();
  await more.press("Enter");
  await dock.press("Enter");
  await expect(popup).toBeHidden();
  await expect(page.locator('[data-lsp-doc="window"]')).toContainText("Returns the total.");
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
  const more = popup.getByRole("button", { name: "More Actions" });
  await expect(more).toBeVisible();
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
  // Repositioning after a viewport resize lands a frame later: read the actions once they settle.
  await expect
    .poll(async () => {
      const first = await more.boundingBox();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      return JSON.stringify(first) === JSON.stringify(await more.boundingBox());
    })
    .toBe(true);
  const actionsBefore = (await more.boundingBox())!;
  await expect(body.locator("pre")).toContainText(signature);
  const scroll = await body.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return { top: node.scrollTop, horizontalOverflow: node.scrollWidth - node.clientWidth };
  });
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.horizontalOverflow).toBeLessThanOrEqual(1);
  const lastBounds = (await last.boundingBox())!;
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(actionsBefore.y + 1);
  expect(await more.boundingBox()).toEqual(actionsBefore);
  await expect(more).toBeInViewport();
  await more.click();
  await expect(page.getByRole("menu", { name: "More Actions" })).toBeInViewport({ ratio: 1 });
});
