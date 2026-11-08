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

test("Kotlin semantic roles stay inside backend and lexer marks", async ({ page }) => {
  await page.goto("/e2e/kotlinHighlight.html?semantic");
  const declaration = page.locator(".cm-sem-function.cm-sem-declaration");
  await expect(declaration).toHaveText("greet");
  await expect(declaration).toHaveCSS("color", "rgb(85, 119, 153)");
  await expect(declaration).toHaveCSS("background-color", "rgb(221, 238, 255)");
  await expect(declaration).toHaveCSS("font-weight", "700");
  await expect(declaration.locator("span")).toHaveCount(0);
  const parameter = page.locator(".cm-sem-parameter.cm-sem-mutable");
  await expect(parameter).toHaveText("prefix");
  await expect(parameter).toHaveCSS("color", "rgb(102, 136, 170)");
  await expect(parameter).toHaveCSS("text-decoration-line", "underline");
  await expect(parameter.locator("span")).toHaveCount(0);
});
