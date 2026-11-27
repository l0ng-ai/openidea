import { expect, test } from "@playwright/test";

type Probe = { count(): number; resolve(index: number, label?: string): void; wrap(): void };

test("scrolling does not let an old viewport response replace current inlay hints", async ({ page }) => {
  await page.goto("/e2e/inlayRequests.html");
  const count = () => page.evaluate(() => (window as unknown as { inlayTest: Probe }).inlayTest.count());
  await expect.poll(count).toBe(1);
  await page.locator(".cm-scroller").evaluate((el) => {
    el.scrollTop = 12000;
  });
  await expect.poll(count).toBe(2);
  await page.evaluate(() => (window as unknown as { inlayTest: Probe }).inlayTest.resolve(1));
  await expect(page.locator(".cm-lsp-inlay")).toHaveText("hint-1");
  await page.evaluate(() => (window as unknown as { inlayTest: Probe }).inlayTest.resolve(0));
  await page.waitForTimeout(500);
  await expect(page.locator(".cm-lsp-inlay")).toHaveText("hint-1");
});

test("inlay hints keep a one-pixel size difference and wrap as a single label", async ({ page }) => {
  await page.goto("/e2e/inlayRequests.html");
  await expect.poll(() => page.evaluate(() => (window as unknown as { inlayTest: Probe }).inlayTest.count())).toBe(1);
  await page.evaluate(() => {
    const { inlayTest } = window as unknown as { inlayTest: Probe };
    inlayTest.resolve(0, "Result of calculation for the second parcel");
  });
  const content = page.locator(".cm-content");
  const hint = page.locator(".cm-lsp-inlay");

  await content.evaluate((el) => (el.style.fontSize = "13px"));
  await expect(hint).toHaveCSS("font-size", "12px");
  await expect(hint).toHaveCSS("vertical-align", "baseline");
  await expect(hint).toHaveCSS("padding-left", "6px");
  await content.evaluate((el) => (el.style.fontSize = "24px"));
  await expect(hint).toHaveCSS("font-size", "23px");

  await page.setViewportSize({ width: 300, height: 500 });
  await page.evaluate(() => (window as unknown as { inlayTest: Probe }).inlayTest.wrap());
  await expect(content).toHaveClass(/cm-lineWrapping/);
  await expect(hint).toHaveCSS("white-space", "pre");
  await expect.poll(() => hint.evaluate((el) => el.getClientRects().length)).toBe(1);
});
