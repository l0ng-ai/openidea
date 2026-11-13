import { expect, test } from "@playwright/test";

type Probe = { count(): number; resolve(index: number): void };

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
