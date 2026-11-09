import { expect, openFromTree, test } from "./fixtures";

/** The end of a long line must stay visible: the floating corner widgets leave it room. */
test("the inspection widget does not cover the end of a long line", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("x".repeat(600));
  await expect(editor.locator(".cm-line")).toHaveCount(1);
  await expect(editor.locator(".cm-openidea-corner")).toBeAttached();

  const scroller = editor.locator(".cm-scroller");
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });

  const rects = await editor.evaluate((el) => {
    const line = el.querySelector(".cm-line")!;
    const range = document.createRange();
    range.selectNodeContents(line);
    return {
      textRight: range.getBoundingClientRect().right,
      cornerLeft: el.querySelector(".cm-openidea-corner")!.getBoundingClientRect().left,
      scrollLeft: el.querySelector(".cm-scroller")!.scrollLeft,
    };
  });
  // Scrolled as far right as it goes, and the last character sits left of the widget.
  expect(rects.scrollLeft).toBeGreaterThan(0);
  expect(rects.cornerLeft).toBeGreaterThan(rects.textRight);
});
