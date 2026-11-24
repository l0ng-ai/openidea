import { expect, test } from "@playwright/test";

const line = (page: import("@playwright/test").Page, n: number) => page.locator(".cm-line").nth(n).locator("span");

test("JavaScript methods keep the function colours until the scheme sets method colours", async ({ page }) => {
  await page.goto("/e2e/jsMethodStyle.html");
  // Unset: a method declaration looks like a function declaration, its calls like function calls.
  await expect(line(page, 0)).toHaveClass(/cm-sem-js-instance-method/);
  await expect(line(page, 0)).toHaveCSS("color", "rgb(102, 136, 170)");
  await expect(line(page, 1)).toHaveCSS("color", "rgb(153, 187, 221)");
  await expect(line(page, 2)).toHaveCSS("color", "rgb(153, 187, 221)");
  await expect(line(page, 2)).toHaveCSS("font-style", "italic");
  await expect(line(page, 3)).toHaveCSS("color", "rgb(153, 187, 221)");

  await page.goto("/e2e/jsMethodStyle.html?methods");
  // Set: declarations and calls of a method share its colour; plain functions keep theirs.
  await expect(line(page, 0)).toHaveCSS("color", "rgb(224, 108, 117)");
  await expect(line(page, 1)).toHaveCSS("color", "rgb(224, 108, 117)");
  await expect(line(page, 2)).toHaveCSS("color", "rgb(207, 142, 109)");
  await expect(line(page, 3)).toHaveCSS("color", "rgb(153, 187, 221)");
});
