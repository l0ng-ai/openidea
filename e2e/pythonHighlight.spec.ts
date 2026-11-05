import { expect, test } from "@playwright/test";

test("Python syntax supplements retain PyCharm colours without a language server", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/e2e/pythonHighlight.html?baseline");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.screenshot({ path: info.outputPath("before.png") });
  await page.goto("/e2e/pythonHighlight.html");
  await expect(page.locator(".cm-sem-python-definition")).toHaveText("outer");
  await expect(page.locator(".cm-sem-python-definition")).toHaveCSS("color", "rgb(34, 68, 102)");
  await expect(page.locator(".cm-sem-python-nested")).toHaveCSS("color", "rgb(51, 85, 119)");
  await expect(page.locator(".cm-sem-python-docstring")).toHaveCSS("color", "rgb(102, 136, 170)");
  await expect(page.locator(".cm-sem-python-docstring")).toHaveCSS("text-decoration-line", "none");
  await expect(page.locator(".cm-sem-python-bytes").first()).toHaveCSS("color", "rgb(119, 153, 187)");
  await expect(page.locator(".cm-sem-python-bytes").first()).toHaveCSS("font-weight", "700");
  await expect(page.locator(".cm-sem-python-escape")).toHaveCSS("color", "rgb(136, 170, 204)");
  await expect(page.locator(".cm-sem-python-annotation").first()).toHaveCSS("color", "rgb(153, 187, 221)");
  await expect(page.locator(".cm-sem-self").first()).toHaveCSS("color", "rgb(170, 119, 136)");
  await expect(page.locator(".cm-sem-python-method-call")).toHaveCSS("color", "rgb(85, 119, 153)");
  await expect(
    page
      .locator(".cm-line")
      .filter({ hasText: "nested(x)" })
      .locator(".cm-sem-function")
      .filter({ hasText: /^nested$/ }),
  ).toHaveCSS("color", "rgb(68, 102, 136)");
  await expect(
    page
      .locator(".cm-line")
      .filter({ hasText: "# Comment" })
      .locator("span")
      .filter({ hasText: /^# Comment$/ }),
  ).toHaveCSS("color", "rgb(102, 119, 136)");
  const print = page
    .locator(".cm-sem-python-builtin")
    .filter({ hasText: /^print$/ })
    .first();
  await expect(print).toHaveText("print");
  await expect(print).toHaveCSS("color", "rgb(187, 136, 153)");
  await expect(page.locator(".cm-sem-python-keyword-arg")).toHaveCSS("color", "rgb(204, 153, 170)");
  await expect(page.locator(".cm-sem-python-local-variable").first()).toHaveCSS("color", "rgb(170, 17, 1)");
  await expect(page.locator(".cm-sem-python-global-variable").first()).toHaveCSS("color", "rgb(170, 34, 2)");
  await expect(page.locator(".cm-sem-python-instance-attribute").first()).toHaveCSS("color", "rgb(170, 51, 3)");
  await expect(page.locator(".cm-sem-python-class-attribute").first()).toHaveCSS("color", "rgb(170, 68, 4)");
  await expect(page.locator(".cm-sem-python-constant").first()).toHaveCSS("color", "rgb(170, 85, 5)");
  await expect(page.locator(".cm-sem-python-property").first()).toHaveCSS("color", "rgb(170, 102, 6)");
  await expect(page.locator(".cm-sem-python-type-parameter").first()).toHaveCSS("color", "rgb(170, 119, 7)");
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("python-highlighting.png") });
});
