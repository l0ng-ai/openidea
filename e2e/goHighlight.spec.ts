import { expect, test } from "@playwright/test";

test("gopls constants and globals use the Go scheme attributes", async ({ page }) => {
  await page.goto("/e2e/goHighlight.html");
  await expect(page.locator(".cm-sem-constant")).toHaveText("Limit");
  await expect(page.locator(".cm-sem-constant")).toHaveCSS("color", "rgb(34, 68, 102)");
  await expect(page.locator(".cm-sem-global")).toHaveText("Global");
  await expect(page.locator(".cm-sem-global")).toHaveCSS("color", "rgb(51, 85, 119)");
  await expect(page.locator(".cm-sem-namespace")).toHaveText("fmt");
});
