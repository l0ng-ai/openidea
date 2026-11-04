import { expect, openFromTree, test } from "./fixtures";

// Headless Chromium hides scrollbars by default, so nothing native sits at the editor's right
// edge and the press reaches the overview lane. The tests in `overviewLane.spec.ts` keep a
// scrollbar there instead.
test("pressing the overview lane scrolls instead of starting a text selection", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(Array.from({ length: 400 }, (_, i) => `val line${i} = ${i}`).join("\n"));
  await page.keyboard.press("Escape");
  const scroller = editor.locator(".cm-scroller");
  await scroller.evaluate((s) => (s.scrollTop = 0));
  const box = (await scroller.boundingBox())!;
  // The lane replaces the native scrollbar: a press on it must stay a scrollbar press.
  const x = box.x + box.width - 5;
  const y = box.y + box.height - 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 120, { steps: 8 });
  await page.mouse.up();
  const empty = await editor.locator(".cm-content").evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: { state: { selection: { main: { empty: boolean } } } } } }).cmTile
      .view;
    return view.state.selection.main.empty;
  });
  expect(empty).toBe(true);
});
