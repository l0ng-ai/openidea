import { expect, test } from "@playwright/test";

test("semantic roles honor all Color Scheme attributes and keep modifier styles", async ({ page }) => {
  await page.goto("/e2e/semanticStyle.html");
  for (const [selector, color] of [
    [".cm-sem-keyword", "rgb(153, 187, 221)"],
    [".cm-sem-namespace", "rgb(68, 102, 136)"],
    [".cm-sem-type", "rgb(85, 119, 153)"],
    [".cm-sem-function:not(.cm-sem-static)", "rgb(102, 136, 170)"],
    [".cm-sem-parameter", "rgb(119, 153, 187)"],
    [".cm-sem-constant", "rgb(136, 170, 204)"],
  ]) {
    const role = page.locator(selector);
    await expect(role).toHaveCSS("color", color!);
    await expect(role).toHaveCSS("background-color", "rgb(221, 238, 255)");
  }
  await expect(page.locator(".cm-sem-namespace")).toHaveCSS("font-style", "italic");
  for (const selector of [".cm-sem-type", ".cm-sem-function", ".cm-sem-parameter", ".cm-sem-constant"]) {
    await expect(page.locator(selector).first()).toHaveCSS("font-weight", "700");
  }
  await expect(page.locator(".cm-sem-function:not(.cm-sem-static)")).toHaveCSS("font-style", "normal");
  await expect(page.locator(".cm-sem-function:not(.cm-sem-static)")).toHaveCSS("text-decoration-line", "underline");
  await expect(page.locator(".cm-sem-function.cm-sem-static")).toHaveCSS("font-style", "italic");
  for (const role of [".cm-sem-function.cm-sem-deprecated", ".cm-sem-property.cm-sem-deprecated"]) {
    await expect(page.locator(role)).toHaveCSS("text-decoration-line", "line-through");
  }
});
