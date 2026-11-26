import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

/** Settings › Editor › General › Appearance › Use smooth caret movement, in the plain-browser store. */
async function enableSmoothCaret(page: Page) {
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    useProject.setState({
      settings: {
        editor: {
          appearance: { smoothCaretMovement: true, caretMovementStyle: "gliding", smoothCaretBlinking: true },
        },
      },
    });
  });
}

/** The primary editor's selection and where its caret is drawn. */
async function caretState(page: Page) {
  return page.evaluate(async () => {
    const controllerModule = "/src/editor/core/controller.ts";
    const { editorController, useEditorStatus } = await import(/* @vite-ignore */ controllerModule);
    const path = useEditorStatus.getState().status!.path;
    const view = editorController().manager.get(path)!.primarySlot()!.view!;
    const layer = view.scrollDOM.querySelector(":scope > .cm-cursorLayer") as HTMLElement;
    const main = view.state.selection.main;
    const head = view.coordsAtPos(main.head);
    const cursor = layer.querySelector(".cm-cursor") as HTMLElement | null;
    return {
      empty: main.empty,
      glide: layer.classList.contains("cm-openidea-caretGlide"),
      caretX: cursor?.getBoundingClientRect().left ?? null,
      headX: head?.left ?? null,
    };
  });
}

/** Client points of two offsets on the first line. */
async function linePoints(page: Page, a: number, b: number) {
  return page.evaluate(
    async ({ a, b }) => {
      const controllerModule = "/src/editor/core/controller.ts";
      const { editorController, useEditorStatus } = await import(/* @vite-ignore */ controllerModule);
      const path = useEditorStatus.getState().status!.path;
      const view = editorController().manager.get(path)!.primarySlot()!.view!;
      const line = view.state.doc.line(1);
      const at = (offset: number) => {
        const c = view.coordsAtPos(line.from + offset)!;
        return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
      };
      return { a: at(a), b: at(b) };
    },
    { a, b },
  );
}

const caretGap = async (page: Page) => {
  const s = await caretState(page);
  return s.caretX === null || s.headX === null ? Infinity : Math.abs(s.caretX - s.headX);
};

/** The CSS animations on the cursor layer; the blink is one of them. */
const layerAnimations = (page: Page): Promise<{ name: string; state: AnimationPlayState }[]> =>
  page.evaluate(async () => {
    const controllerModule = "/src/editor/core/controller.ts";
    const { editorController, useEditorStatus } = await import(/* @vite-ignore */ controllerModule);
    const path = useEditorStatus.getState().status!.path;
    const view = editorController().manager.get(path)!.primarySlot()!.view!;
    const layer = view.scrollDOM.querySelector(".cm-cursorLayer")!;
    return (layer.getAnimations() as Animation[]).map((animation) => ({
      name: (animation as CSSAnimation).animationName,
      state: animation.playState,
    }));
  });

/** Two frames: CodeMirror draws new caret positions in a measure on the next frame. */
const nextFrames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

test("smooth caret follows the pointer during a drag and still glides a click", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await enableSmoothCaret(page);
  await expect(editor).toHaveClass(/cm-openidea-caretMotion-gliding/);
  await editor.locator(".cm-content").click();
  await page.waitForTimeout(250);

  const { a, b } = await linePoints(page, 0, 20);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await nextFrames(page);
  const drag = await caretState(page);
  expect(drag.empty).toBe(false);
  expect(drag.glide).toBe(false);
  expect(await caretGap(page)).toBeLessThanOrEqual(3);

  // Dragging back onto the anchor empties the selection without restarting the transition.
  await page.mouse.move(a.x, a.y, { steps: 10 });
  await nextFrames(page);
  expect((await caretState(page)).empty).toBe(true);
  expect((await caretState(page)).glide).toBe(false);
  expect(await caretGap(page)).toBeLessThanOrEqual(3);
  // Cancelling the caret's moves must leave the blink animation on the cursor layer alone.
  const blink = await layerAnimations(page);
  expect(blink.some((a) => /^cm-blink/.test(a.name) && a.state === "running")).toBe(true);
  await page.mouse.up();

  // Clicks still glide.
  await page.mouse.dblclick(b.x, b.y);
  await expect.poll(async () => (await caretState(page)).empty).toBe(false);
  await expect.poll(async () => (await caretState(page)).glide).toBe(true);

  await page.keyboard.down("Shift");
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await caretState(page)).empty).toBe(false);
  await expect.poll(async () => (await caretState(page)).glide).toBe(true);

  await page.mouse.click(a.x, a.y);
  await expect.poll(async () => (await caretState(page)).empty).toBe(true);
  await expect.poll(async () => (await caretState(page)).glide).toBe(true);
});
