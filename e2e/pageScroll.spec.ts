import { expect, openFromTree, test } from "./fixtures";

test("an open editor leaves nothing for the page itself to scroll", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  const page_ = await page.evaluate(() => {
    window.scrollBy(0, 100);
    const root = document.documentElement;
    return { scrollY: window.scrollY, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
  });
  expect(page_.scrollY).toBe(0);
  expect(page_.scrollHeight).toBe(page_.clientHeight);
});

test("scrolling to where the editor already is keeps the page in place", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await expect(editor.locator(".cm-content")).toBeVisible();
  const scrollY = await page.evaluate(async () => {
    const content = document.querySelector(".cm-content") as HTMLElement & {
      cmTile?: { view: never };
      cmView?: { view: never };
    };
    const view = (content.cmTile ?? content.cmView)!.view as {
      constructor: { scrollIntoView(pos: number, options: { y: string }): unknown };
      dispatch(spec: { effects: unknown }): void;
      requestMeasure(): void;
    };
    for (let i = 0; i < 2; i++) {
      view.dispatch({ effects: view.constructor.scrollIntoView(0, { y: "start" }) });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    }
    return window.scrollY;
  });
  expect(scrollY).toBe(0);
});
