import type { EditorView } from "@codemirror/view";
import { expect, test } from "./fixtures";

const compact = '{"name":"Ada","tags":["math","code"],"n":9007199254740993}';

for (const type of ["json", "text"]) {
  test(`JSON value window preserves text and uses ${type} validation rules`, async ({ workbench: page }) => {
    await page.evaluate(
      async ({ compact, type }) => {
        const reactPath = "/node_modules/.vite/deps/react.js";
        const domPath = "/node_modules/.vite/deps/react-dom_client.js";
        const viewPath = "/src/features/database/DataView.tsx";
        const react = await import(reactPath);
        const dom = await import(domPath);
        const { createElement, useState } = react.default ?? react;
        const { createRoot } = dom.default ?? dom;
        const { DataView } = await import(viewPath);
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;inset:100px;z-index:100;display:flex;background:var(--bg-main)";
        document.body.append(host);
        function Value() {
          const [value, setValue] = useState(compact);
          return createElement(DataView, {
            columns: [{ name: "payload", type }],
            rowCount: 1,
            value: () => value,
            editable: true,
            panel: "value",
            onPanelChange: () => {},
            onEdit: (_row: number, _col: number, text: string) => setValue(text),
          });
        }
        createRoot(host).render(createElement(Value));
      },
      { compact, type },
    );
    const cell = page.getByRole("gridcell", { name: compact, exact: true });
    await cell.click();
    const panel = page.getByRole("complementary", { name: "Value panel" });
    const editor = panel.locator(".cm-content");
    await expect(editor).toContainText("9007199254740993");
    await expect(panel.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
    await cell.press("Shift+Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".cm-content")).toBeFocused();
    await expect
      .poll(() =>
        dialog.locator(".cm-editor").evaluate((editor) => {
          const body = editor.closest("[data-dialog-body]")!;
          return Math.abs(body.clientHeight - editor.clientHeight);
        }),
      )
      .toBeLessThanOrEqual(4);
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(cell).toHaveText(compact);
    await editor.evaluate((element) => {
      const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '{"name":"Grace","n":9007199254740993}' },
      });
      view.focus();
    });
    await page.keyboard.press("Meta+Alt+L");
    await expect(editor.locator(".cm-line")).toHaveCount(4);
    await page.keyboard.press("Meta+f");
    await expect(panel.locator(".cm-search")).toBeVisible();
    await panel.locator(".cm-search button[name=close]").click();
    await panel.getByRole("button", { name: "Open in Window", exact: true }).click();
    await expect(dialog.locator(".cm-content")).toContainText("Grace");
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    await dialog.locator(".cm-content").evaluate((element) => {
      const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "plain text" } });
    });
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });
    if (type === "json") {
      await expect(apply).toBeDisabled();
      await expect(dialog.getByRole("status")).toBeVisible();
    } else {
      await expect(apply).toBeEnabled();
      await apply.click();
      await expect(page.getByRole("gridcell", { name: "plain text", exact: true })).toBeVisible();
    }
  });
}

test("validates a large JSON value in a worker and applies the exact edited text", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const viewPath = "/src/features/database/JsonValueEditor.tsx";
    const react = await import(reactPath);
    const dom = await import(domPath);
    const { createElement } = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    const { JsonValueWindow } = await import(viewPath);
    const host = document.createElement("div");
    document.body.append(host);
    const result = document.createElement("output");
    result.id = "applied-json";
    document.body.append(result);
    createRoot(host).render(
      createElement(JsonValueWindow, {
        title: "Edit payload",
        initial: '{"large":"' + "x".repeat(5_000_000) + '"}',
        validate: true,
        onClose: () => {},
        onApply: (text: string) => {
          result.textContent = text;
        },
      }),
    );
  });
  const dialog = page.getByRole("dialog", { name: "Edit payload" });
  const editor = dialog.locator(".cm-content");
  await expect(dialog.getByRole("button", { name: "Reformat", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Reformat", exact: true }).click();
  await expect
    .poll(() =>
      editor.evaluate(
        (element) =>
          (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view.state.doc.toString() ===
          '{\n  "large": "' + "x".repeat(5_000_000) + '"\n}',
      ),
    )
    .toBe(true);
  await editor.evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length } });
  });
  await expect(dialog.getByRole("status")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await editor.evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '{\n "large": "' + "x".repeat(5_000_000) + '"\n}' },
    });
  });
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator("#applied-json")
        .evaluate((element) => element.textContent === '{\n "large": "' + "x".repeat(5_000_000) + '"\n}'),
    )
    .toBe(true);
});
