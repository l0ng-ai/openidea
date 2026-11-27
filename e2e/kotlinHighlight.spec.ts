import { expect, test } from "@playwright/test";

for (const semantic of [false, true]) {
  test(`${semantic ? "semantic" : "syntax"} token backgrounds paint only their own row`, async ({ page }) => {
    await page.goto(`/e2e/kotlinHighlight.html${semantic ? "?semantic" : ""}`);
    await page.addStyleTag({ content: ".cm-editor .cm-scroller { font: 18px/18px monospace; }" });
    const editor = page.locator(".cm-editor");
    const row = editor.locator(".cm-line", { hasText: "fun greet" });
    const token = semantic
      ? row.locator(".cm-sem-function")
      : row
          .locator("span")
          .filter({ hasText: /^greet$/ })
          .last();
    await expect(token).toHaveCSS("color", "rgb(85, 119, 153)");
    expect((await token.boundingBox())!.height).toBeGreaterThan((await row.boundingBox())!.height);

    const neighbors = () => editor.screenshot({ mask: [row] });
    const before = await neighbors();
    const highlighted = await row.screenshot();
    await page.addStyleTag({ content: ".cm-editor .cm-line span { --syn-function-bg: transparent !important; }" });
    expect((await row.screenshot()).equals(highlighted), "the token fill should be visible").toBe(false);
    expect((await neighbors()).equals(before), "changing the fill must not repaint adjacent rows").toBe(true);
  });
}

test("Kotlin backend roles override lexer styles", async ({ page }) => {
  await page.goto("/e2e/kotlinHighlight.html");
  const greet = page
    .locator(".cm-line span")
    .filter({ hasText: /^greet$/ })
    .last();
  await expect(greet).toHaveCSS("color", "rgb(85, 119, 153)");
  await expect(greet).toHaveCSS("background-image", /rgb\(221, 238, 255\)/);
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
  await expect(declaration).toHaveCSS("background-image", /rgb\(221, 238, 255\)/);
  await expect(declaration).toHaveCSS("font-weight", "700");
  await expect(declaration.locator("span")).toHaveCount(0);
  const parameter = page.locator(".cm-sem-parameter.cm-sem-mutable");
  await expect(parameter).toHaveText("prefix");
  await expect(parameter).toHaveCSS("color", "rgb(102, 136, 170)");
  await expect(parameter).toHaveCSS("text-decoration-line", "underline");
  await expect(parameter.locator("span")).toHaveCount(0);
});
