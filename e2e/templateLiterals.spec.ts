import { expect, test } from "./fixtures";

test("template literals highlight and comment in their embedded language", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    docBackend().files.set(
      "/dev/acme-api/styles.ts",
      "const Button = styled.button`\n  padding: 4px;\n`;\nconst QUERY = gql`\n  query Cart { total }\n`;\nconst plain = `margin: 0`;\n",
    );
    await editorService().openFile("/dev/acme-api/styles.ts");
  });
  const content = page.locator('.cm-editor[data-language="TypeScript"] .cm-content');
  await expect(content).toBeVisible();
  // Each word of an embedded language is a token of its own; a plain literal stays one string.
  await expect(content.locator("span").filter({ hasText: /^padding$/ })).toBeVisible();
  await expect(content.locator("span").filter({ hasText: /^query$/ })).toBeVisible();
  await expect(content.locator("span").filter({ hasText: /^`margin: 0`$/ })).toBeVisible();

  await content.evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: import("@codemirror/view").EditorView } }).cmTile.view;
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("query") } });
    view.focus();
  });
  await page.keyboard.press("Meta+/");
  await expect(content).toContainText("# query Cart { total }");
});
