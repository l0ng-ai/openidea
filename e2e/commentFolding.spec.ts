import { expect, openFromTree, test } from "./fixtures";

for (const { name, source, expected } of [
  {
    name: "multiline documentation comment",
    source: "/**\n * Creates a visitor record.\n * More detail.\n */\nexport const visitor = 1;",
    expected: "/** Creates a visitor record. ...*/",
  },
  {
    name: "inline documentation header",
    source: "/** Returns the visitor name.\n * More detail.\n */\nexport const visitor = 1;",
    expected: "/**...*/",
  },
  {
    name: "ordinary block comment",
    source:
      "/*\n * Ordinary block comment for comparison.\n * It is not a documentation comment.\n */\nexport const visitor = 1;",
    expected: "/* Ordinary block comment for comparison. ...*/",
  },
]) {
  test(`folds a JavaScript ${name} like IDEA`, async ({ workbench: page }, testInfo) => {
    const editor = await openFromTree(page, "App.tsx");
    const content = editor.locator(".cm-content");
    await content.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.insertText(source);
    await expect(editor.locator(".cm-line").first()).toHaveText(source.split("\n")[0]!);

    await editor.locator(".cm-foldGutter .cm-openidea-foldOpen").first().click();
    await expect(editor.locator(".cm-line").first()).toHaveText(expected);
    await page.screenshot({ path: testInfo.outputPath("folded.png"), animations: "disabled" });

    await editor.locator(".cm-foldPlaceholder").first().click();
    await expect(editor.locator(".cm-line").first()).toHaveText(source.split("\n")[0]!);
  });
}
