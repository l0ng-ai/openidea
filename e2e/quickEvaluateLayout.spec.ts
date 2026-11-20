import type { EditorView } from "@codemirror/view";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Quick Evaluate opens an object tree that fits the editor and returns focus on Escape", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 445, height: 500 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/settlement.py";
    const h = window.__ipc.handlers;
    const value = (name: string, text: string, typeName: string, variablesReference = 0) => ({
      name,
      value: text,
      typeName,
      variablesReference,
      evaluateName: name,
    });
    h.fs_probe = () => ({ size: 48, binary: false, tooLarge: false });
    h.fs_read_text = () => "summary = {}\nsubtotal = 42\n";
    h.debug_evaluate_in = ({ expression }) =>
      expression === "summary" ? value("summary", "{...}", "dict", 101) : value("subtotal", "42", "int");
    h.debug_variables = ({ reference }) =>
      reference === 101
        ? [value("audit", "{...}", "dict", 102), value("total", "47.74", "float")]
        : Array.from({ length: 22 }, (_, i) => value(`entry${i.toString().padStart(2, "0")}`, String(i), "int"));
    h.debug_scopes = () => [];
    const servicesModule = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ servicesModule);
    await editorService().openFile(path, { focus: true });
    const debugModule = "/src/features/debugger/state.ts";
    const { adoptSession, publishContext } = await import(/* @vite-ignore */ debugModule);
    adoptSession(91, {
      name: "Checkout",
      adapter: "debugpy",
      status: "paused",
      selectedFrame: 11,
      frames: [{ id: 11, name: "checkout", path, line: 0, column: 0, presentationHint: null }],
    });
    publishContext();
  });
  const editor = page.locator(".cm-editor");
  const content = editor.locator(".cm-content");
  await expect(content).toBeVisible();
  await content.evaluate((el) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "summary = {}\nsubtotal = 42\n" } });
  });
  const evaluate = (line: number) =>
    content.evaluate(async (el, lineNo) => {
      const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNo).from + 2 } });
      const actionModule = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionModule)).executeAction("debug.quickEvaluate");
    }, line);

  await evaluate(1);
  const hint = page.locator(".cm-lsp-hint");
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("button", { name: "Expand value" })).toHaveCount(0);
  const tree = hint.getByRole("tree", { name: "summary" });
  await expect(tree).toBeFocused();
  await expect(tree.getByText("audit", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 400, height: 360 });
  await expect
    .poll(async () => {
      const editorBox = (await editor.boundingBox())!;
      const hintBox = (await hint.boundingBox())!;
      return hintBox.x >= editorBox.x - 1 && hintBox.x + hintBox.width <= editorBox.x + editorBox.width + 1;
    })
    .toBe(true);

  await tree.getByText("audit", { exact: true }).click();
  await tree.press("ArrowRight");
  await expect(tree.getByText("entry00", { exact: true })).toBeVisible();
  expect(await tree.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await tree.press("Escape");
  await expect(hint).toBeHidden();
  await expect(content).toBeFocused();

  await evaluate(2);
  await expect(hint.getByRole("tree")).toHaveCount(0);
  await expect(hint).toHaveText(/subtotal\s*=\s*42/);
  expect(await ipcCalls(page, "debug_evaluate_in")).toEqual([
    { session: 91, frameId: 11, expression: "summary", context: "hover" },
    { session: 91, frameId: 11, expression: "subtotal", context: "hover" },
  ]);
});
