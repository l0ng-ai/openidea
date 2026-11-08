import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  for (const extension of ["http", "rest"] as const) {
    test(`highlights request lines and JSON bodies in ${extension} files (${theme})`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/e2e/httpHighlight.html?theme=${theme}${extension === "rest" ? "&rest" : ""}`);
      const token = (text: string) =>
        page
          .locator(".cm-line span")
          .filter({ hasText: new RegExp(`^${text}$`) })
          .first();
      const keyword = theme === "light" ? "rgb(0, 51, 179)" : "rgb(207, 142, 109)";
      const property = theme === "light" ? "rgb(135, 16, 148)" : "rgb(199, 125, 187)";
      const string = theme === "light" ? "rgb(6, 125, 23)" : "rgb(106, 171, 115)";
      for (const method of ["GRPC", "WEBSOCKET", "POST"]) await expect(token(method)).toHaveCSS("color", keyword);
      await expect(token('"name"')).toHaveCSS("color", property);
      await expect(token('"World"')).toHaveCSS("color", string);
      await expect(token("12")).toHaveCSS("color", theme === "light" ? "rgb(23, 80, 235)" : "rgb(42, 172, 184)");
      for (const literal of ["true", "false", "null"]) await expect(token(literal)).toHaveCSS("color", keyword);
      await expect(token("Content-Type")).toHaveCSS("color", property);
      expect(errors).toEqual([]);
    });
  }
}
