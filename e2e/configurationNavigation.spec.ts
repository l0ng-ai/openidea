import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

async function keyPosition(page: Page) {
  const line = page.locator("#config .cm-line").filter({ hasText: "driver-class-name" });
  const box = (await line.boundingBox())!;
  // Skip the two-space indentation, land within the actual key.
  return { x: box.x + 45, y: box.y + box.height / 2 };
}
async function open(page: Page) {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await page.goto("/e2e/configurationNavigation.html");
  await expect(page.locator("#config .cm-content")).toContainText("driver-class-name");
}
async function metrics(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        navigationMetrics: () => {
          requests: number;
          hoverRequests: number;
          latency: number[];
          injectedServerDelayMs: number;
        };
      }
    ).navigationMetrics(),
  );
}

test("modifier hover and repeated clicks share results; editing Java invalidates them", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const key = await keyPosition(page);
  await page.keyboard.down("Meta");
  await page.mouse.move(key.x, key.y);
  await expect(page.locator(".cm-lsp-link")).toHaveText("driver-class-name");
  await expect(page.locator(".cm-lsp-link")).toHaveCSS("cursor", "pointer");
  await expect(page.locator(".cm-lsp-link")).toHaveCSS("color", "rgb(33, 92, 200)");
  expect((await metrics(page)).hoverRequests).toBe(0);
  await expect(page.locator(".cm-lsp-nav-info")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("configuration-link.png") });
  await page.mouse.click(key.x, key.y);
  await expect(page.locator("#opened")).toHaveText("/fixture/Settings.java:0");
  await page.keyboard.up("Meta");
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: "Back to configuration" }).click();
    await page.keyboard.down("Meta");
    await page.mouse.click(key.x, key.y);
    await expect(page.locator("#java")).toBeVisible();
    await page.keyboard.up("Meta");
  }
  const warm = await metrics(page);
  expect(warm.requests).toBe(1);
  expect(warm.latency).toHaveLength(11);
  const evidence = info.outputPath("warm-navigation.json");
  await writeFile(evidence, JSON.stringify(warm, null, 2));
  await info.attach("warm-navigation.json", { path: evidence, contentType: "application/json" });
  await page.getByRole("button", { name: "Edit Java target" }).click();
  await page.getByRole("button", { name: "Back to configuration" }).click();
  await page.keyboard.down("Meta");
  await page.mouse.click(key.x, key.y);
  await expect(page.locator("#opened")).toHaveText("/fixture/Settings.java:1");
  expect((await metrics(page)).requests).toBe(2);
  expect(errors).toEqual([]);
});

test("clicking before the hover query completes shares the in-flight request", async ({ page }, info) => {
  await open(page);
  const key = await keyPosition(page);
  await page.keyboard.down("Meta");
  await page.mouse.move(key.x, key.y);
  await expect(page.locator("#requests")).toHaveText("1");
  await page.mouse.click(key.x, key.y);
  await expect(page.locator("#opened")).toHaveText("/fixture/Settings.java:0");
  const result = await metrics(page);
  expect(result.requests).toBe(1);
  await info.attach("inflight-navigation.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
});

test("ordinary hover still shows configuration documentation", async ({ page }) => {
  await open(page);
  const key = await keyPosition(page);
  await page.mouse.move(key.x, key.y);
  await expect(page.locator(".cm-lsp-hover")).toContainText("dingtalk.driver-class-name String");
  expect((await metrics(page)).requests).toBe(0);
  expect((await metrics(page)).hoverRequests).toBeGreaterThan(0);
});
