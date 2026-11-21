import type { EditorView } from "@codemirror/view";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

function codeStart(line: Locator) {
  return line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const content = node.textContent ?? "";
      const start = content.search(/\S/);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      return range.getBoundingClientRect().left;
    }
    throw new Error("Expected source text");
  });
}

test("Sticky Lines follows editor text, line numbers and the viewport below Find", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  const header = "for (const value of entries)";
  const path = "/dev/acme-api/sticky-layout.ts";
  const source = [
    "export function summarizeLedger(entries: number[]) {",
    "\tlet total = 0;",
    `\t${header} {`,
    "\t\tif (value > 0) {",
    ...Array.from({ length: 110 }, (_, index) => {
      const extra = index === 30 ? " + value".repeat(140) : "";
      return `\t\t\ttotal += value * ${index + 1}${extra};`;
    }),
    "\t\t}",
    "\t}",
    "\treturn total;",
    "}",
  ].join("\n");
  await page.evaluate(
    async ({ path, source }) => {
      const backendPath = "/src/editor/core/backend.ts";
      const servicesPath = "/src/workbench/contributions.ts";
      const projectPath = "/src/platform/project.ts";
      const { docBackend } = await import(/* @vite-ignore */ backendPath);
      const { editorService } = await import(/* @vite-ignore */ servicesPath);
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const settings = useProject.getState().settings;
      useProject.setState({
        settings: {
          ...settings,
          editor: {
            ...settings?.editor,
            fontSize: 16,
            appearance: { ...settings?.editor?.appearance, lineNumbers: true, lineNumberMode: "relative" },
          },
        },
      });
      docBackend().files.set(path, source);
      await editorService().openFile(path);
    },
    { path, source },
  );

  const editor = page.locator('.cm-editor[data-language="TypeScript"]');
  const content = editor.locator(".cm-content");
  const scroller = editor.locator(".cm-scroller");
  const liveHeader = content.locator(".cm-line").filter({ hasText: header });
  await expect(liveHeader).toBeVisible();
  const liveX = await codeStart(liveHeader);
  await content.evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    const target = view.state.doc.line(28).from;
    view.dispatch({ selection: { anchor: target } });
    view.focus();
    view.scrollDOM.scrollTop = view.lineBlockAt(target).top;
  });

  const sticky = editor.locator(".cm-openidea-sticky");
  const pinned = sticky.locator('.cm-openidea-stickyLine[data-line="3"]');
  const gutter = pinned.locator(".cm-openidea-stickyGutter");
  const text = pinned.locator(".cm-openidea-stickyInner");
  await expect(gutter).toBeVisible();
  await expect(sticky.locator(".cm-openidea-stickyNumber")).toHaveText(["27", "25", "24"]);
  const [liveGutter, pinnedGutter] = await Promise.all([
    editor.locator(".cm-gutters").boundingBox(),
    gutter.boundingBox(),
  ]);
  expect(pinnedGutter!.x).toBeCloseTo(liveGutter!.x, 0);
  expect(pinnedGutter!.width).toBeCloseTo(liveGutter!.width, 0);
  expect(await codeStart(text)).toBeCloseTo(liveX, 0);
  await expect(sticky).toHaveCSS("font-size", "16px");
  await expect(sticky).toHaveCSS("tab-size", await content.evaluate((element) => getComputedStyle(element).tabSize));
  await scroller.evaluate((element) => {
    element.scrollLeft = 32;
  });
  await expect.poll(() => codeStart(text)).toBeCloseTo(liveX - 32, 0);
  await scroller.evaluate((element) => {
    element.scrollLeft = 0;
  });

  await page.keyboard.press("Meta+f");
  const find = page.getByRole("search", { name: "Find in file" }).getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeFocused();
  await expect(pinned).toBeVisible();
  expect((await sticky.boundingBox())!.y).toBeCloseTo((await scroller.boundingBox())!.y, 0);
  expect((await find.boundingBox())!.y).toBeLessThan((await sticky.boundingBox())!.y);

  await page.setViewportSize({ width: 470, height: 520 });
  await expect(sticky).toBeInViewport({ ratio: 1 });
  const overview = editor.locator(".cm-openidea-overview");
  const [stickyBox, lane, row] = await Promise.all([
    sticky.boundingBox(),
    overview.boundingBox(),
    pinned.boundingBox(),
  ]);
  expect(stickyBox!.x + stickyBox!.width).toBeCloseTo(lane!.x + lane!.width, 0);
  expect(row!.x + row!.width).toBeCloseTo(lane!.x, 0);
  expect(
    await overview.evaluate((element, y) => {
      const { x, width } = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(x + width / 2, y));
    }, row!.y + 4),
  ).toBe(true);
  await find.press("Escape");
  await pinned.locator(".cm-openidea-stickyText").click({ position: { x: 32, y: 4 } });
  await expect(content.locator(".cm-activeLine")).toContainText(header);
});
