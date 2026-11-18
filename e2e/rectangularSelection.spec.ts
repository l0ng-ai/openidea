import { expect, openFromTree, test } from "./fixtures";

test("middle and Alt drags create editable rectangles without changing ordinary selection", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  const text = "alpha = 111;\nbravo = 222;\ncharl = 333;\ndelta = 444;";
  const prepare = () =>
    page.evaluate(async (text) => {
      const controllerModule = "/src/editor/core/controller.ts";
      const columnModule = "/src/editor/core/cm/columnMode.ts";
      const { editorController } = await import(/* @vite-ignore */ controllerModule);
      const { setColumnMode } = await import(/* @vite-ignore */ columnModule);
      const view = editorController().activeSlot.view;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: setColumnMode.of(false),
      });
      view.focus();
      const a = view.coordsAtPos(0);
      const b = view.coordsAtPos(view.state.doc.line(4).from + 5);
      return {
        from: { x: a.left + 0.5, y: (a.top + a.bottom) / 2 },
        to: { x: b.left + 0.5, y: (b.top + b.bottom) / 2 },
      };
    }, text);
  const selection = () =>
    page.evaluate(async () => {
      const controllerModule = "/src/editor/core/controller.ts";
      const columnModule = "/src/editor/core/cm/columnMode.ts";
      const { editorController } = await import(/* @vite-ignore */ controllerModule);
      const { isColumnMode } = await import(/* @vite-ignore */ columnModule);
      const view = editorController().activeSlot.view;
      return {
        ranges: view.state.selection.ranges.map((r: { from: number; to: number }) => view.state.sliceDoc(r.from, r.to)),
        columnMode: isColumnMode(view.state),
        text: view.state.doc.toString(),
      };
    });
  for (const button of ["middle", "left"] as const) {
    const points = await prepare();
    if (button === "left") await page.keyboard.down("Alt");
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down({ button });
    await page.mouse.move(points.to.x, points.to.y, { steps: 5 });
    await page.mouse.up({ button });
    if (button === "left") await page.keyboard.up("Alt");
    await expect.poll(async () => (await selection()).ranges).toEqual(["alpha", "bravo", "charl", "delta"]);
    expect((await selection()).columnMode).toBe(false);
  }
  await page.keyboard.insertText("name");
  await expect.poll(async () => (await selection()).text).toBe("name = 111;\nname = 222;\nname = 333;\nname = 444;");
  const points = await prepare();
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await selection()).ranges).toEqual([text.slice(0, text.lastIndexOf("delta") + 5)]);
});
