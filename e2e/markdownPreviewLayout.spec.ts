import type { EditorView } from "@codemirror/view";
import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

async function choosePreviewLayout(page: Page, layout: "Side by side" | "Stacked") {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Markdown");
  await settings.getByRole("treeitem", { name: "Markdown", exact: true, level: 2 }).click();
  const select = settings.getByRole("button", { name: "Preview layout", exact: true });
  await expect(select).toBeVisible();
  await select.click();
  await page.getByRole("option", { name: layout, exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
}

async function ratio(editor: Locator, preview: Locator, axis: "height" | "width") {
  const [source, rendered] = await Promise.all([editor.boundingBox(), preview.boundingBox()]);
  return source![axis] / (source![axis] + rendered![axis]);
}

test("copies fenced Markdown code with hover or keyboard in both preview layouts", async ({
  workbench: page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const bash = "  printf '%s\\n' '<&>'\n\n  echo done";
  const python = "if True:\n    print('hello')";
  const plain = "first\n\n  second";
  const mermaid = "flowchart TD\n    A --> B";
  const source = [
    "# Examples",
    "```bash\n\n" + bash + "\n\n```",
    "- Python\n\n  ~~~python\n  " + python.replace("\n", "\n  ") + "\n  ~~~",
    "```\n" + plain + "  \n```",
    "    indented code",
    '<pre data-markdown-fence><code class="language-bash">raw HTML</code></pre>',
    "```mermaid\n" + mermaid + "\n```",
  ].join("\n\n");
  await page.evaluate(async (source) => {
    const backendPath = "/src/editor/core/backend.ts";
    const servicePath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(servicePath);
    const path = "/dev/acme-api/code-examples.md";
    docBackend().files.set(path, source);
    await editorService().openFile(path);
  }, source);

  const preview = page.getByRole("document", { name: "Markdown preview" });
  const copies = preview.getByRole("button", { name: /^(Copy Code|Copied!)$/ });
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await expect(copies).toHaveCount(4);
  await expect(preview.locator("pre")).toHaveCount(6);
  await page.mouse.move(0, 0);
  await expect(copies.first()).toHaveCSS("opacity", "0");
  await preview.locator("pre").first().hover();
  await expect(copies.first()).toHaveCSS("opacity", "1");
  await copies.first().click();
  await expect(copies.first()).toHaveAccessibleName("Copied!");
  await expect.poll(readClipboard).toBe(bash);
  await expect(copies.first()).toHaveAccessibleName("Copy Code");

  await page.mouse.move(0, 0);
  await copies.first().focus();
  await page.keyboard.press("Tab");
  await expect(copies.nth(1)).toBeFocused();
  await expect(copies.nth(1)).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect.poll(readClipboard).toBe(python);

  await page.getByRole("button", { name: "Preview Only", exact: true }).click();
  await expect(copies).toHaveCount(4);
  await preview.locator("pre").nth(2).hover();
  await copies.nth(2).click();
  await expect.poll(readClipboard).toBe(plain);
  const diagram = preview.locator('[data-mermaid-state="ok"]');
  await expect(diagram.getByRole("button", { name: "Full screen", exact: true })).toBeVisible();
  await diagram.hover();
  await diagram.getByRole("button", { name: "Copy Code", exact: true }).click();
  await expect.poll(readClipboard).toBe(mermaid);
  await page.getByRole("button", { name: "Editor and Preview", exact: true }).click();
  await expect(copies).toHaveCount(4);
});

test("Markdown settings can stack the preview and remember each direction's split", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await page.evaluate(() =>
    localStorage.setItem("openidea.markdown.split", JSON.stringify({ editor: 65, preview: 35 })),
  );
  const editor = await openFromTree(page, "README.md");
  const preview = page.getByRole("document", { name: "Markdown preview" });
  const divider = page.getByRole("separator", { name: "Resize Markdown preview" });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => ratio(editor, preview, "width")).toBeCloseTo(0.65, 2);

  await choosePreviewLayout(page, "Stacked");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const source = (await editor.boundingBox())!;
  const rendered = (await preview.boundingBox())!;
  expect(rendered.y).toBeGreaterThanOrEqual(source.y + source.height);
  expect(rendered.x).toBeCloseTo(source.x, 0);
  expect(rendered.width).toBeCloseTo(source.width, 0);
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(0.5, 2);

  await divider.press("ArrowUp");
  await expect.poll(() => ratio(editor, preview, "height")).toBeLessThan(0.49);
  const stackedRatio = await ratio(editor, preview, "height");

  await choosePreviewLayout(page, "Side by side");
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(() => ratio(editor, preview, "width")).toBeCloseTo(0.65, 2);
  await choosePreviewLayout(page, "Stacked");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(stackedRatio, 2);

  await page.getByRole("button", { name: "Preview Only" }).click();
  await expect(preview).toBeVisible();
  await expect(divider).toBeHidden();
  await page.getByRole("button", { name: "Editor and Preview" }).click();
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect.poll(() => ratio(editor, preview, "height")).toBeCloseTo(stackedRatio, 2);
});

test("wrapped Markdown uses the source pane width beside the preview", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Example\n\n" + "x ".repeat(320));
  await expect(content).toHaveClass(/cm-lineWrapping/);
  const paragraph = content.locator(".cm-line").filter({ hasText: "x x x" });
  const corner = editor.getByRole("toolbar", { name: "Inspections" });
  await expect(corner).toBeVisible();

  for (const width of [1100, 1400]) {
    await page.setViewportSize({ width, height: 780 });
    await expect
      .poll(() =>
        paragraph.evaluate((line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          const right = Math.max(...Array.from(range.getClientRects(), (rect) => rect.right));
          const overview = line.closest(".cm-editor")!.querySelector(".cm-openidea-overview")!;
          const lane = overview.getBoundingClientRect();
          const gap = lane.left - right;
          return {
            padding: parseFloat(getComputedStyle(line).paddingRight) - lane.width,
            textFits: gap >= 0 && gap < 20,
          };
        }),
      )
      .toEqual({ padding: 0, textFits: true });
  }

  await page.getByRole("button", { name: "Editor Only", exact: true }).click();
  await expect
    .poll(() => paragraph.evaluate((line) => parseFloat(getComputedStyle(line).paddingRight)))
    .toBeGreaterThan(40);
});

async function openStickySettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Sticky Lines");
  await settings.getByRole("treeitem", { name: "Sticky Lines", exact: true }).click();
  return settings;
}

test("applies the Markdown sticky-lines setting to an open editor", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const servicePath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(servicePath);
    const path = "/dev/acme-api/headings.md";
    const source = "# Overview\n\n" + "Paragraph text.\n\n".repeat(120);
    docBackend().files.set(path, source);
    await editorService().openFile(path);
  });
  const preview = page.getByRole("document", { name: "Markdown preview" });
  const heading = preview.getByRole("heading", { name: "Overview" });
  await expect(heading).toBeVisible();
  const editor = page.locator(".cm-editor:visible");
  await editor.locator(".cm-content").evaluate(async (el) => {
    const module = "/src/editor/core/cm/folding.ts";
    const { setBackendFolds } = await import(module);
    const view = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    // Supply the section fold produced by the desktop Markdown parser.
    view.dispatch({
      effects: setBackendFolds.of([{ start_line: 0, end_line: view.state.doc.lines - 1, kind: "region" }]),
    });
    view.focus();
    view.scrollDOM.scrollTop = 600;
  });
  const pinned = editor.locator(".cm-openidea-stickyLine").filter({ hasText: "Overview" });
  await expect(pinned).toBeVisible();
  const checkbox = page.getByRole("checkbox", { name: "Markdown" });
  let settings = await openStickySettings(page);
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pinned).toBeVisible();
  settings = await openStickySettings(page);
  await checkbox.uncheck();
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(editor.locator(".cm-openidea-sticky")).toHaveCount(0);
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(heading).toBeAttached();
  settings = await openStickySettings(page);
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
});

async function openSections(page: Page, mode: "Preview Only" | "Editor Only" | "Editor and Preview") {
  const target = "Section 30";
  await page.setViewportSize({ width: 1100, height: 760 });
  const line = await page.evaluate(async (title) => {
    const backendPath = "/src/editor/core/backend.ts";
    const servicePath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(servicePath);
    const path = "/dev/acme-api/sections.md";
    const paragraph = "Wrapping changes the height of this paragraph when the docked pane closes. ".repeat(11);
    const sections = Array.from({ length: 65 }, (_, i) => `## Section ${i}\n\n${paragraph}\n\n`);
    const source = sections.join("");
    docBackend().files.set(path, source);
    await editorService().openFile(path);
    return source.split("\n").indexOf(`## ${title}`);
  }, target);
  await page.getByRole("button", { name: mode, exact: true }).click();
  await stubDesktop(page);
  await page.evaluate(
    async ({ name, line }) => {
      const pos = { line, col: 3 };
      window.__ipc.handlers.doc_outline = () => [
        {
          name,
          kind: "key",
          range: { start: { line, col: 0 }, end: { line: line + 2, col: 0 } },
          selection_range: { start: pos, end: pos },
          children: [],
        },
      ];
      const path = "/src/workbench/toolwindows/store.ts";
      const { moveToolWindow, setToolWindowSize, showToolWindow } = await import(path);
      moveToolWindow("structure", "right");
      setToolWindowSize("right", 330);
      showToolWindow("structure", true);
    },
    { name: target, line },
  );
  const panel = page.getByRole("region", { name: "Structure", exact: true });
  const stripe = page.locator('[data-stripe-button="structure"]');
  return { target, line, panel, stripe };
}

const position = (heading: Locator) =>
  heading.evaluate((el) => {
    const preview = el.closest('[aria-label="Markdown preview"]')!;
    return { y: el.getBoundingClientRect().top - preview.getBoundingClientRect().top, width: preview.clientWidth };
  });

const settled = (preview: Locator) =>
  preview.evaluate((el) => {
    const style = getComputedStyle(el);
    const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.abs(width - parseFloat(style.getPropertyValue("--markdown-block-width")));
  });

test("keeps the Markdown reading position when toggling the right Structure stripe", async ({ workbench: page }) => {
  const { target, panel, stripe } = await openSections(page, "Preview Only");
  const preview = page.getByRole("document", { name: "Markdown preview" });
  const heading = preview.getByRole("heading", { name: target, exact: true });
  await expect.poll(() => settled(preview)).toBeLessThanOrEqual(1);
  const starting = await position(heading);
  await panel.getByRole("treeitem", { name: target, exact: true }).click();
  await expect.poll(async () => (await position(heading)).y).toBeGreaterThanOrEqual(-1);
  await expect.poll(async () => (await position(heading)).y).toBeLessThan(45);
  const before = await position(heading);
  expect(starting.y).toBeGreaterThan(before.y + 1000);
  await stripe.click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await position(heading)).width).toBeGreaterThan(before.width + 200);
  await expect.poll(() => settled(preview)).toBeLessThanOrEqual(1);
  expect(Math.abs((await position(heading)).y - before.y)).toBeLessThanOrEqual(2);

  const readingHeading = preview.getByRole("heading", { name: "Section 35", exact: true });
  await readingHeading.evaluate((el) => {
    const preview = el.closest('[aria-label="Markdown preview"]')!;
    preview.scrollTop += el.getBoundingClientRect().top - preview.getBoundingClientRect().top + 12;
  });
  await expect.poll(async () => Math.abs((await position(readingHeading)).y + 12)).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await position(heading)).y).toBeLessThan(-500);
  const reading = await position(readingHeading);
  await stripe.click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await position(readingHeading)).width).toBeLessThan(reading.width - 200);
  await expect.poll(() => settled(preview)).toBeLessThanOrEqual(1);
  expect(Math.abs((await position(readingHeading)).y - reading.y)).toBeLessThanOrEqual(2);
});

for (const mode of ["Editor Only", "Editor and Preview"] as const) {
  test(`keeps wrapped Markdown in place when toggling Structure in ${mode}`, async ({ workbench: page }) => {
    const { target, line, panel, stripe } = await openSections(page, mode);
    const source = page.locator(".cm-content:visible");
    const preview = page.getByRole("document", { name: "Markdown preview" });
    const previewHeading = preview.getByRole("heading", { name: "Section 49", exact: true });
    const readSource = (pos: number | null = null) =>
      source.evaluate((el, pos) => {
        const view = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
        const viewport = view.scrollDOM.getBoundingClientRect();
        const marker =
          pos ?? view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: viewport.top + 2 });
        const coords = marker !== null ? view.coordsAtPos(marker) : null;
        const markerLine = marker !== null ? view.state.doc.lineAt(marker) : null;
        const caret = view.state.selection.main.head;
        return {
          marker,
          caret: view.state.doc.lineAt(caret).number,
          markerLine: markerLine?.number,
          markerColumn: markerLine && marker !== null ? marker - markerLine.from : 0,
          y: coords ? coords.top - viewport.top : null,
          width: view.scrollDOM.clientWidth,
        };
      }, pos);
    const browseSource = (section: number, column: number) =>
      source.evaluate(
        (el, { section, column }) => {
          const view = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
          const line = view.state.doc.line(section * 4 + (column ? 3 : 1));
          view.dispatch({
            effects: (view.constructor as typeof EditorView).scrollIntoView(line.from + column, {
              y: "start",
              yMargin: 0,
            }),
          });
        },
        { section, column },
      );
    await expect(source).toHaveClass(/cm-lineWrapping/);
    await panel.getByRole("treeitem", { name: target, exact: true }).click();
    await expect.poll(async () => (await readSource()).caret).toBe(line + 1);
    await browseSource(35, 500);
    await expect.poll(async () => (await readSource()).markerLine).toBe(35 * 4 + 3);
    if (mode === "Editor and Preview") {
      await expect.poll(() => settled(preview)).toBeLessThanOrEqual(1);
      await expect.poll(async () => (await position(previewHeading)).y).toBeGreaterThan(800);
      await previewHeading.evaluate((el) => {
        const preview = el.closest('[aria-label="Markdown preview"]')!;
        preview.scrollTop += el.getBoundingClientRect().top - preview.getBoundingClientRect().top + 12;
      });
      await expect.poll(async () => Math.abs((await position(previewHeading)).y + 12)).toBeLessThanOrEqual(1);
    }
    const before = await readSource();
    const reading = mode === "Editor and Preview" ? await position(previewHeading) : null;
    expect(before.markerColumn).toBeGreaterThan(200);
    expect(before.marker).not.toBeNull();
    expect(before.y).not.toBeNull();
    for (const open of [false, true, false, true]) {
      await stripe.click();
      await expect(stripe).toHaveAttribute("aria-pressed", String(open));
      if (!open) await expect.poll(async () => (await readSource()).width).toBeGreaterThan(before.width + 100);
      else await expect.poll(async () => (await readSource()).width).toBe(before.width);
      await expect
        .poll(async () => {
          const after = await readSource(before.marker);
          return after.y === null ? Infinity : Math.abs(after.y - before.y!);
        })
        .toBeLessThanOrEqual(2);
      expect((await readSource()).caret).toBe(line + 1);
      if (reading) {
        await expect.poll(() => settled(preview)).toBeLessThanOrEqual(1);
        expect(Math.abs((await position(previewHeading)).y - reading.y)).toBeLessThanOrEqual(2);
      }
    }
    if (mode === "Editor and Preview") {
      const followerHeading = preview.getByRole("heading", { name: "Section 52", exact: true });
      await browseSource(52, 0);
      await expect.poll(async () => Math.abs((await position(followerHeading)).y)).toBeLessThanOrEqual(45);
    }
  });
}
