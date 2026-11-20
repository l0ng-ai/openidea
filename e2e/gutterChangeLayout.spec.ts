import type { EditorView } from "@codemirror/view";
import { expect, stubDesktop, test } from "./fixtures";

test("an inline change keeps its actions and original code readable at the editor zoom", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 445, height: 520 });
  await stubDesktop(page);
  const original = "const routingPolicy = 'use the legacy regional settlement cutoff before reconciliation';";
  const current = "const routingPolicy = 'use the current policy';";
  const content = Array.from({ length: 22 }, (_, i) => {
    if (i === 4) return current;
    if (i === 11) return "const settlementWindow = 12;";
    return `// context ${i + 1}`;
  }).join("\n");

  await page.evaluate(async (text) => {
    const service = "/src/workbench/contributions.ts";
    window.__ipc.handlers.fs_probe = () => ({ size: text.length, binary: false, tooLarge: false });
    window.__ipc.handlers.fs_read_text = () => text;
    await (await import(/* @vite-ignore */ service)).editorService().openFile("/dev/acme-api/settlement.ts");
  }, content);
  const editor = page.locator(".cm-editor");
  await expect(editor.locator(".cm-content")).toBeVisible();

  await editor.evaluate(
    async (el, { original, content }) => {
      const { view } = (el.querySelector(".cm-content") as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
      view.dom.style.setProperty("--openidea-editor-font-size", "18px");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0 } });
      window.__ipc.handlers.vcs_line_hunks = () => [
        { kind: "modified", start: 4, lines: 1, oldStart: 4, oldLines: 1, oldText: original + "\n" },
        { kind: "added", start: 11, lines: 1, oldStart: 11, oldLines: 0, oldText: "" },
        { kind: "deleted", start: 15, lines: 0, oldStart: 14, oldLines: 1, oldText: "// obsolete window\n" },
      ];
      const storeModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ storeModule);
      useVcs.setState({ available: true, version: useVcs.getState().version + 1 });
    },
    { original, content },
  );
  await editor.getByTitle("Modified lines (click to show)", { exact: true }).click();
  const modified = page.getByRole("dialog", { name: "Modified lines" });
  await expect(modified).toBeVisible();
  const originalText = modified.getByText(original, { exact: false });
  await expect(originalText).toHaveCSS("font-size", "18px");
  await expect(modified.getByText(current, { exact: false })).toHaveCount(0);
  await expect(editor.getByText(current, { exact: true })).toBeVisible();

  const preview = modified.getByRole("region", { name: "Original text" });
  await expect(preview.locator(".tok-keyword")).toHaveText("const");
  const toolbar = modified.getByRole("toolbar", { name: "Change actions" });
  expect(await preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const previewBox = (await preview.boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  const currentBox = (await editor.getByText(current, { exact: true }).boundingBox())!;
  expect(previewBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height - 1);
  expect(
    toolbarBox.y >= currentBox.y + currentBox.height - 1 || previewBox.y + previewBox.height <= currentBox.y + 1,
  ).toBe(true);
  expect(previewBox.x).toBeGreaterThanOrEqual(0);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(445);
  await toolbar.getByRole("button", { name: "Next Change" }).click();
  const added = page.getByRole("dialog", { name: "Added lines" });
  await expect(added).toBeVisible();
  await expect(added.getByRole("region", { name: "Original text" })).toHaveCount(0);
  await expect(added.getByRole("button", { name: "Copy Original Text" })).toBeDisabled();

  await added.getByRole("button", { name: "Next Change" }).click();
  const deleted = page.getByRole("dialog", { name: "Deleted lines" });
  await expect(deleted.getByRole("region", { name: "Original text" })).toHaveText("// obsolete window");
  await deleted.getByRole("button", { name: "Rollback" }).click();
  await expect(deleted).toBeHidden();
  await expect(editor.getByText("// obsolete window", { exact: true })).toBeVisible();
});
