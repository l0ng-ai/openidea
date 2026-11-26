import { expect, test } from "@playwright/test";

for (const mode of ["dark", "light"]) {
  test(`C++ standard and user namespaces share the namespace colour (${mode})`, async ({ page }) => {
    await page.goto(`/e2e/cppNamespaceStyle.html${mode === "light" ? "?light" : ""}`);
    const namespaces = page.locator(".cm-sem-namespace");
    await expect(namespaces).toHaveCount(2);
    for (const namespace of await namespaces.all()) {
      await expect(namespace).toHaveCSS("color", "rgb(68, 102, 136)");
    }
  });
}
