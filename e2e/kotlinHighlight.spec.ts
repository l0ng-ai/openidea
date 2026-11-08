import { expect, test } from "@playwright/test";

test("Kotlin backend roles override lexer styles", async ({ page }) => {
  await page.goto("/e2e/kotlinHighlight.html");
  const greet = page
    .locator(".cm-line span")
    .filter({ hasText: /^greet$/ })
    .last();
  await expect(greet).toHaveCSS("color", "rgb(85, 119, 153)");
  await expect(greet).toHaveCSS("background-color", "rgb(221, 238, 255)");
  await expect(greet).toHaveCSS("font-weight", "700");
  await expect(
    page
      .locator(".cm-line span")
      .filter({ hasText: /^prefix$/ })
      .last(),
  ).toHaveCSS("color", "rgb(102, 136, 170)");
});
