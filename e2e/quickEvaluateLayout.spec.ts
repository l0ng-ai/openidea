import type { EditorView } from "@codemirror/view";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Quick Evaluate and hover keep value previews usable in a narrow editor", async ({ workbench: page }) => {
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
      expression === "summary"
        ? value("summary", `{'audit': '${"Regional settlement totals ".repeat(8)}'}`, "dict", 101)
        : value("subtotal", "42", "int");
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
  const scalar = hint.locator("[class*='_valueTooltip_']");
  const uiFont = await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily);
  await expect(scalar).toHaveCSS("font-family", uiFont);
  await expect(scalar).toHaveCSS("font-size", "13px");
  await expect(scalar).toHaveCSS("font-weight", "700");
  await expect(scalar.locator(".cm-openidea-icon")).toHaveCount(1);
  await content.press("Escape");
  await expect(hint).toBeHidden();

  await page.setViewportSize({ width: 620, height: 480 });
  await page.evaluate(async () => {
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const servicesModule = "/src/workbench/contributions.ts";
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
    const { toolWindowService } = await import(/* @vite-ignore */ servicesModule);
    moveToolWindow("project", "left");
    setToolWindowSize("left", 220);
    toolWindowService().show("project", false);
  });
  await expect.poll(async () => (await editor.boundingBox())!.x).toBeGreaterThan(160);
  const position = await content.evaluate((el) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    return view.coordsAtPos(view.state.doc.line(1).from + 2);
  });
  await page.mouse.move(position!.left, (position!.top + position!.bottom) / 2);
  const hover = page.locator(".cm-tooltip-hover").locator("[class*='_valueTooltip_']");
  const expand = hover.getByRole("button", { name: "Expand value" });
  await expect(hover).toContainText("Regional settlement totals");
  await expect(hover).toHaveCSS("font-family", uiFont);
  const summary = hover.locator("[class*='_valueText_']");
  const textBox = (await summary.boundingBox())!;
  const controlBox = (await expand.boundingBox())!;
  const iconBox = (await hover.locator(".cm-openidea-icon").boundingBox())!;
  expect(textBox.height).toBeGreaterThan(20);
  expect(Math.abs(controlBox.y - iconBox.y)).toBeLessThan(1);
  expect(textBox.x).toBeGreaterThanOrEqual(iconBox.x + iconBox.width);
  const fitsEditor = async () => {
    const tooltip = await hover.boundingBox();
    const pane = (await editor.boundingBox())!;
    return !!tooltip && tooltip.x >= pane.x - 1 && tooltip.x + tooltip.width <= pane.x + pane.width + 1;
  };
  await expect.poll(fitsEditor).toBe(true);
  await page.setViewportSize({ width: 555, height: 480 });
  await expect.poll(fitsEditor).toBe(true);
  await expand.click();
  const pinned = hint.getByRole("tree", { name: "summary" });
  await expect(pinned).toBeFocused();
  await pinned.press("Escape");
  await expect(content).toBeFocused();
  const calls = await ipcCalls(page, "debug_evaluate_in");
  expect(calls.filter((call) => call.context === "watch")).toEqual([
    { session: 91, frameId: 11, expression: "summary", context: "watch" },
    { session: 91, frameId: 11, expression: "subtotal", context: "watch" },
  ]);
  expect(calls).toContainEqual({ session: 91, frameId: 11, expression: "summary", context: "hover" });
});
