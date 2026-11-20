/**
 * Code intelligence through the editor: completion, navigation, usages, rename, quick fixes and
 * diagnostics. The language server is stubbed at the IPC layer; the servers themselves are covered
 * by `crates/ide-lsp/tests`.
 */
import type { Locator, Page } from "@playwright/test";
import type { CompletionItem } from "../src/bindings";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/build.gradle.kts`;

const at = (line: number, col: number) => ({ line, col });
const range = (line: number, from: number, to: number) => ({ start: at(line, from), end: at(line, to) });

/** Puts the caret just before `word` on the line containing `text`. */
async function caretAt(editor: Locator, page: Page, text: string, word: string) {
  const line = editor.locator(".cm-line", { hasText: text });
  await line.click();
  await page.keyboard.press("Home");
  const content = (await line.textContent()) ?? "";
  const indent = content.length - content.trimStart().length;
  for (let i = indent; i < content.indexOf(word); i++) await page.keyboard.press("ArrowRight");
}

async function openSample(page: Page) {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  return editor;
}

test("completion lists the server's items and inserts the chosen one", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(() => {
    const item = (label: string, kind: string, detail: string, insertText: string) => ({
      label,
      labelDetail: kind === "property" ? ` ${detail}` : "()",
      detail,
      kind,
      documentation: null,
      sortText: null,
      filterText: null,
      preselect: false,
      deprecated: false,
      insertText,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: "kotlin",
    });
    window.__ipc.handlers.lsp_completion = () => ({
      isIncomplete: false,
      items: [item("toDto", "method", "OrderDto", "toDto()"), item("total", "property", "BigDecimal", "total")],
    });
  });
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("order");
  const firstPlacement = await page.evaluateHandle(() => {
    const sample: { labelX?: number } = {};
    const observer = new MutationObserver(() => {
      const label = document.querySelector(
        ":is(.cm-tooltip-above, .cm-tooltip-below).cm-lsp-completion .cm-completionLabel",
      );
      if (!label) return;
      sample.labelX = label.getBoundingClientRect().left;
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    return sample;
  });
  await page.keyboard.type(".");
  await page.keyboard.press("Control+Space");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.getByText("total", { exact: true })).toBeVisible();
  await expect(popup.getByText("toDto", { exact: true })).toBeVisible();
  expect((await popup.boundingBox())!.width).toBeLessThan(360);
  const field = popup.locator("li").filter({ has: page.locator(".cm-completionLabel", { hasText: /^total$/ }) });
  await expect(field.locator(".cm-completionDetail")).toHaveCount(0);
  await expect(field.locator(".cm-lsp-type")).toHaveText("BigDecimal");
  const method = popup.locator("li").filter({ has: page.locator(".cm-completionLabel", { hasText: /^toDto$/ }) });
  await expect(method.locator(".cm-completionDetail")).toHaveText("()");
  await expect(method.locator(".cm-lsp-type")).toHaveText("OrderDto");
  // CodeMirror anchors the popup at the completion's `from` (the word start), and the kind icon
  // hangs left of the label. With no prefix typed yet `from` is the caret, so the label's x must
  // match the caret column rather than the popup's left edge.
  const wordStart = await editor.locator(".cm-content").evaluate(async (content) => {
    const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
    const { EditorView } = await import(/* @vite-ignore */ viewModule);
    const view = EditorView.findFromDOM(content as HTMLElement)!;
    return view.coordsAtPos(view.state.selection.main.head)!.left;
  });
  const label = await method.locator(".cm-completionLabel").boundingBox();
  // Subpixel rounding differs per platform/font; a mis-set inset is a whole icon column off.
  const firstLabelX = await firstPlacement.evaluate((sample) => sample.labelX!);
  expect(Math.abs(firstLabelX - wordStart)).toBeLessThanOrEqual(2);
  expect(Math.abs(label!.x - wordStart)).toBeLessThanOrEqual(2);
  const zoomedSize = await editor.locator(".cm-content").evaluate(async (content) => {
    const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
    const prefsModule = "/src/editor/core/cm/prefs.ts";
    const { EditorView } = await import(/* @vite-ignore */ viewModule);
    const { stepFontZoom } = await import(/* @vite-ignore */ prefsModule);
    const fontSize = Number.parseFloat(getComputedStyle(content).fontSize);
    stepFontZoom(EditorView.findFromDOM(content as HTMLElement)!, 6);
    return `${fontSize + 6}px`;
  });
  await expect(editor.locator(".cm-content")).toHaveCSS("font-size", zoomedSize);
  await expect(method.locator(".cm-completionLabel")).toHaveCSS("font-size", zoomedSize);
  await page.keyboard.type("toD");
  await expect(popup.getByText("total", { exact: true })).toBeHidden();
  // Refreshing the results rebuilds the list; the hint bar must stay below it, not jump to the top.
  const footerBelowList = await popup.evaluate((t) => {
    const list = t.querySelector(":scope > ul")!;
    const footer = t.querySelector(":scope > .cm-lsp-completion-footer")!;
    return footer.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1;
  });
  expect(footerBelowList).toBe(true);
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toHaveText(/^\s*order\.toDto\(\)$/);
  expect((await ipcCalls(page, "lsp_completion")).length).toBeGreaterThan(0);
});

test("long completion signatures fit the editor when the workbench is narrowed", async ({ workbench: page }) => {
  const editor = await openSample(page);
  const label = "transformOrder" + "AcrossParticipatingRegions".repeat(5);
  await page.evaluate((label) => {
    const item: CompletionItem = {
      label,
      labelDetail: "(order: Order, options: TransformationOptions)",
      labelDescription: "Promise<TransformationResult>",
      detail: `${label}(order: Order, options: TransformationOptions): Promise<TransformationResult>`,
      kind: "method",
      documentation: { kind: "markdown", value: "Transforms the order." },
      sortText: null,
      filterText: null,
      preselect: true,
      deprecated: false,
      insertText: `${label}()`,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: 1,
    };
    window.__ipc.handlers.lsp_completion = () => ({ isIncomplete: false, items: [item] });
  }, label);
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("order.");
  await page.keyboard.press("Control+Space");

  const popup = page.locator(".cm-tooltip-autocomplete");
  const option = popup.getByRole("option").filter({
    has: page.locator(".cm-completionLabel", { hasText: label }),
  });
  await expect(option.locator(".cm-completionLabel")).toHaveText(label);
  await page.setViewportSize({ width: 580, height: 900 });
  const bounds = (await editor.boundingBox())!;
  await expect
    .poll(async () => {
      const box = (await popup.boundingBox())!;
      return Math.max(bounds.x - box.x, box.x + box.width - (bounds.x + bounds.width));
    })
    .toBeLessThanOrEqual(2);
  const geometry = await option.evaluate((row) => {
    const label = row.querySelector<HTMLElement>(".cm-completionLabel")!;
    const type = row.querySelector<HTMLElement>(".cm-lsp-type")!;
    return {
      nameTruncated: label.scrollWidth > label.clientWidth,
      nameWidth: label.clientWidth,
      typeWidth: type.clientWidth,
      typeOverflow: type.getBoundingClientRect().right - row.getBoundingClientRect().right,
    };
  });
  expect(geometry.nameTruncated).toBe(true);
  expect(geometry.nameWidth).toBeGreaterThan(40);
  expect(geometry.typeWidth).toBeGreaterThan(16);
  expect(geometry.typeOverflow).toBeLessThanOrEqual(1);

  await page.keyboard.press("F1");
  await expect(popup.locator(".cm-completionInfo")).toContainText(
    `${label}(order: Order, options: TransformationOptions)`,
  );
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toContainText(`order.${label}()`);
});

test("documentation shows beside the lookup instead of being clipped by it", async ({ workbench: page }, info) => {
  const editor = await openSample(page);
  await page.evaluate(async () => {
    // Long enough for the pane to reach its max-width: a short doc leaves it at
    // `width: max-content`, so the placement assertions would never exercise the room calculation.
    const longDocs =
      "Computes the order total including tax, discounts and shipping, rounded to the currency's scale. " +
      "The result is cached until the order changes, so callers should not hold on to it across edits; " +
      "ask for a fresh value after every update.";
    const item = (label: string, detail: string) => ({
      label,
      labelDetail: "()",
      detail,
      kind: "method",
      documentation: { kind: "markdown", value: `Docs for **${label}**. ${longDocs}` },
      sortText: null,
      filterText: null,
      preselect: false,
      deprecated: false,
      insertText: `${label}()`,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: 1,
    });
    window.__ipc.handlers.lsp_completion = () => ({
      isIncomplete: false,
      items: [item("total", "BigDecimal"), item("toDto", "OrderDto")],
    });
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    const settings = structuredClone(useProject.getState().settings ?? {});
    const editor = settings.editor ?? {};
    settings.editor = {
      ...editor,
      completion: { ...editor.completion, showDocumentation: true, documentationDelay: 0 },
    };
    useProject.setState({ settings });
  });
  const popup = page.locator(".cm-tooltip-autocomplete");

  const openLookup = async () => {
    await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("order.");
    await page.keyboard.press("Control+Space");
    await expect(popup.getByText("total", { exact: true })).toBeVisible();
    await expect(page.locator(".cm-completionInfo")).toContainText("Docs for");
  };

  const geometry = () =>
    page.evaluate(() => {
      const info = document.querySelector(".cm-completionInfo") as HTMLElement;
      const list = (document.querySelector(".cm-tooltip-autocomplete") as HTMLElement).getBoundingClientRect();
      const rect = info.getBoundingClientRect();
      const overlapX = Math.max(0, Math.min(rect.right, list.right) - Math.max(rect.left, list.left));
      const overlapY = Math.max(0, Math.min(rect.bottom, list.bottom) - Math.max(rect.top, list.top));
      const side = info.classList.contains("cm-completionInfo-left")
        ? "left"
        : info.classList.contains("cm-completionInfo-right")
          ? "right"
          : "none";
      return {
        overlap: overlapX * overlapY,
        visible: !!document.elementFromPoint(rect.left + 4, rect.top + 4)?.closest(".cm-completionInfo"),
        inside: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
        side,
      };
    });

  await page.setViewportSize({ width: 760, height: 900 });
  await openLookup();
  await page.screenshot({ path: info.outputPath("completion-documentation.png"), animations: "disabled" });
  const narrow = await geometry();
  expect(narrow.overlap).toBe(0);
  expect(narrow.visible).toBe(true);
  expect(narrow.inside).toBe(true);
  expect(narrow.side).toBe("left");

  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLookup();
  const wide = await geometry();
  expect(wide.overlap).toBe(0);
  expect(wide.visible).toBe(true);
  expect(wide.inside).toBe(true);
  expect(wide.side).toBe("right");
});

test("typing closes an open documentation tooltip", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(() => {
    const item = (label: string) => ({
      label,
      labelDetail: "()",
      detail: "Unit",
      kind: "method",
      documentation: { kind: "markdown", value: `Docs for **${label}**.` },
      sortText: null,
      filterText: null,
      preselect: false,
      deprecated: false,
      insertText: `${label}()`,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: 1,
    });
    window.__ipc.handlers.lsp_completion = () => ({
      isIncomplete: false,
      items: [item("service"), item("serviceName"), item("setUp")],
    });
    window.__ipc.handlers.lsp_hover = () => ({
      contents: { kind: "markdown", value: "Docs for **service**." },
      range: null,
    });
  });
  const geometry = await editor.locator(".cm-content").evaluate(async (content) => {
    const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
    const { EditorView } = await import(/* @vite-ignore */ viewModule);
    const view = EditorView.findFromDOM(content as HTMLElement)!;
    const find = view.state.doc.toString().indexOf("find");
    if (find < 0 || !view.coordsAtPos(find)) throw new Error('the fixture has no visible "find"');
    const word = view.coordsAtPos(find)!;
    view.dispatch({ selection: { anchor: find + 5 } });
    view.focus();
    return { wordX: word.left + 2, wordY: (word.top + word.bottom) / 2 };
  });
  await page.mouse.move(geometry.wordX, geometry.wordY);
  const tooltip = page.locator(".cm-tooltip-hover");
  await expect(tooltip).toBeVisible();
  await page.keyboard.type("se");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.getByText("service", { exact: true })).toBeVisible();
  await expect(tooltip).toHaveCount(0);
});

for (const key of ["Enter", "Tab"]) {
  for (const prefix of ["", "v"]) {
    test(`${key} leaves the caret after a field snippet at root.${prefix}`, async ({ workbench: page }, info) => {
      const editor = await openSample(page);
      await page.evaluate(() => {
        const item = (label: string): CompletionItem => ({
          label,
          labelDetail: null,
          labelDescription: "int",
          detail: "int",
          kind: "field",
          documentation: null,
          sortText: null,
          filterText: null,
          preselect: label === "val",
          deprecated: false,
          insertText: label,
          isSnippet: true,
          replaceRange: null,
          replaceRangeTab: null,
          additionalEdits: [],
          commitCharacters: [],
          command: null,
          data: null,
          server: 1,
        });
        window.__ipc.handlers.lsp_completion = () => ({ isIncomplete: false, items: [item("val"), item("value")] });
      });
      await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(`int a = root.${prefix}`);
      await page.keyboard.press("Control+Space");
      const popup = page.locator(".cm-tooltip-autocomplete");
      await expect(popup.getByText("val", { exact: true })).toBeVisible();
      // CodeMirror ignores acceptance during its 75 ms lookup interaction delay.
      await page.waitForTimeout(100);
      await page.keyboard.press(key);
      await expect(popup).toBeHidden();
      await page.screenshot({ path: info.outputPath("accepted-completion.png"), animations: "disabled" });
      await page.keyboard.type(";");
      await expect(editor.locator(".cm-activeLine")).toHaveText(/^\s*int a = root\.val;$/);
    });
  }
}

test("⌘B goes to the declaration in another file", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ path, target }) => {
      window.__ipc.handlers.lsp_goto = () => [{ path, range: target }];
    },
    { path: `${ROOT}/settings.gradle.kts`, target: range(20, 12, 17) },
  );
  await caretAt(editor, page, "val order: Order", "service");
  await page.keyboard.press("Meta+b");
  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(tabs.getByRole("tab", { name: "settings.gradle.kts" })).toHaveAttribute("aria-selected", "true");
  const target = page.locator(".cm-editor").filter({ has: page.locator(".cm-activeLine") });
  await expect(target.locator(".cm-activeLine")).toContainText("val order: Order = service.create(req)");
  const [args] = await ipcCalls(page, "lsp_goto");
  expect(args).toMatchObject({ pos: at(20, 27), kind: "definition" });
});

test("Find Usages from the editor context menu lists every usage by file and opens one", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, other }) => {
      const loc = (path: string, line: number, from: number, to: number) => ({
        path,
        range: { start: { line, col: from }, end: { line, col: to } },
      });
      window.__ipc.handlers.lsp_references = () => ({
        locations: [loc(file, 16, 8, 15), loc(file, 20, 27, 34), loc(other, 16, 8, 15)],
        incomplete: null,
      });
    },
    { file: FILE, other: `${ROOT}/settings.gradle.kts` },
  );
  await caretAt(editor, page, "val order: Order", "service");
  const caret = await editor.locator(".cm-cursor").boundingBox();
  await page.mouse.click(caret!.x + 2, caret!.y + caret!.height / 2, { button: "right" });
  await page.getByRole("menuitem", { name: /^Find Usages/ }).click();
  expect((await ipcCalls(page, "lsp_references"))[0]).toMatchObject({ pos: at(20, 27) });
  const usages = page.getByRole("tree", { name: /usages/i });
  await expect(usages.getByRole("treeitem", { name: "Found usages 3 results" })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: "build.gradle.kts 2 usages" })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: /^17 service\.find\(status/ })).toBeVisible();
  await expect(usages.getByRole("treeitem", { name: /^21 val order: Order = service\.create/ })).toBeVisible();
  const other = usages.getByRole("treeitem", { name: "settings.gradle.kts 1 usage" });
  await expect(other).toBeVisible();
  // Double-clicking a usage in another file opens that file.
  await usages.getByRole("treeitem", { name: /^17/ }).last().dblclick();
  await expect(
    page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "settings.gradle.kts" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("usage locations and preview stay readable as the available space changes", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 760 });
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, other }) => {
      const locations = [
        { path: file, range: { start: { line: 16, col: 8 }, end: { line: 16, col: 15 } } },
        { path: file, range: { start: { line: 20, col: 27 }, end: { line: 20, col: 34 } } },
        { path: other, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 7 } } },
      ];
      window.__ipc.handlers.lsp_references = () => ({
        locations,
        classified: [{ location: locations[2], kind: "code", text: "service.submit(order)" }],
        incomplete: null,
        librariesSkipped: true,
      });
    },
    { file: FILE, other: `${ROOT}/domain/checkout/processing/calculations/PaymentProcessingService.kt` },
  );
  await caretAt(editor, page, "val order: Order", "service");
  await page.keyboard.press("Meta+Alt+F7");
  const popup = page.getByRole("dialog", { name: "Usages" });
  const scope = popup.getByRole("button", { name: "Scope" });
  const openWindow = popup.getByRole("button", { name: /^Open in Find Window/ });
  await expect(popup.getByTestId("usage-row")).toHaveCount(3);
  await popup.getByRole("button", { name: "Show Preview" }).click();
  const code = popup.getByRole("region", { name: "Preview" });
  await expect(code.locator(".cm-content")).toContainText("service.find(status");

  await page.setViewportSize({ width: 480, height: 470 });
  const within = async (child: Locator, parent: Locator) => {
    const [c, p] = await Promise.all([child.boundingBox(), parent.boundingBox()]);
    return (
      !!c &&
      !!p &&
      c.x >= p.x - 1 &&
      c.y >= p.y - 1 &&
      c.x + c.width <= p.x + p.width + 1 &&
      c.y + c.height <= p.y + p.height + 1
    );
  };
  await expect.poll(() => within(scope, popup)).toBe(true);
  await expect.poll(() => within(openWindow, popup)).toBe(true);
  await expect.poll(() => within(code, popup)).toBe(true);
  const results = popup.getByRole("listbox", { name: "Usages" });
  await expect.poll(() => within(popup.getByTestId("usage-row").last(), results)).toBe(true);
  const firstRow = popup.getByTestId("usage-row").first();
  const file = firstRow.getByText("build.gradle.kts", { exact: true });
  await expect(file).toBeVisible();
  const [filename, snippet] = await Promise.all([file.boundingBox(), firstRow.locator("mark").boundingBox()]);
  expect(filename!.x + filename!.width).toBeLessThan(snippet!.x);
  await openWindow.click();

  const tree = page.getByRole("tree", { name: "Usages" });
  const target = tree.getByRole("treeitem", { name: /^17 service\.find\(status/ });
  await target.click();
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview).toContainText("service.find(status");
  await expect.poll(async () => (await preview.boundingBox())!.y > (await tree.boundingBox())!.y).toBe(true);
  await page.setViewportSize({ width: 1040, height: 760 });
  await expect.poll(async () => (await preview.boundingBox())!.x > (await tree.boundingBox())!.x).toBe(true);
  await expect(preview).toContainText("service.find(status");
});

test("⇧F6 renames in place and sends the server's edit to be applied", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, prepared, uses }) => {
      window.__ipc.handlers.lsp_prepare_rename = () => prepared;
      window.__ipc.handlers.lsp_rename = (args) => ({
        edit: {
          files: [
            {
              kind: "edit",
              path: file,
              edits: uses.map((range) => ({ range, new_text: args.newName })),
            },
          ],
        },
        incomplete: null,
      });
    },
    { file: FILE, prepared: range(20, 12, 17), uses: [range(20, 12, 17), range(21, 15, 20)] },
  );
  await caretAt(editor, page, "val order: Order", "order");
  await page.keyboard.press("Shift+F6");
  await expect(page.getByText(/Press ⇧F6 to show dialog/)).toBeVisible();
  // The name starts selected; occurrences follow as it's typed.
  await page.keyboard.type("placed");
  await expect(editor.locator(".cm-line", { hasText: "val placed: Order" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => ipcCalls(page, "apply_workspace_edit")).toHaveLength(1);
  const [rename] = await ipcCalls(page, "lsp_rename");
  expect(rename).toMatchObject({ pos: at(20, 12), newName: "placed" });
  const [apply] = await ipcCalls(page, "apply_workspace_edit");
  expect(JSON.stringify(apply)).toContain('"new_text":"placed"');
});

test("indexed single-file rename previews all anchors and applies only after confirmation", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, prepared, uses }) => {
      window.__ipc.handlers.lsp_prepare_rename = () => prepared;
      window.__ipc.handlers.lsp_rename = (args) => ({
        preview: true,
        edit: {
          files: [{ kind: "edit", path: file, edits: uses.map((range) => ({ range, new_text: args.newName })) }],
          preconditions: [{ path: file, hash: "indexed-snapshot" }],
        },
        incomplete: null,
      });
      window.__ipc.handlers.apply_workspace_edit = () => null;
    },
    { file: FILE, prepared: range(20, 12, 17), uses: [range(20, 12, 17), range(21, 15, 20)] },
  );
  for (const confirm of [false, true]) {
    await caretAt(editor, page, "val order: Order", "order");
    await page.keyboard.press("Shift+F6");
    await expect(page.getByText(/Press ⇧F6 to show dialog/)).toBeVisible();
    await page.keyboard.type("placed");
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog", { name: "Rename 'order' to 'placed'" });
    await expect(preview).toBeVisible();
    await expect(preview.getByText("2 occurrences in 1 file")).toBeVisible();
    expect(await ipcCalls(page, "apply_workspace_edit")).toHaveLength(0);
    await preview.getByRole("button", { name: confirm ? "Do Refactor" : "Cancel", exact: true }).click();
    await expect(preview).toBeHidden();
  }
  await expect.poll(() => ipcCalls(page, "apply_workspace_edit")).toHaveLength(1);
  const [apply] = await ipcCalls(page, "apply_workspace_edit");
  expect(apply?.edit).toMatchObject({ preconditions: [{ path: FILE, hash: "indexed-snapshot" }] });
});

test("rename keeps the typed name, uses the editor font and shows long preview names in a narrow dialog", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(
    async ({ file, prepared }) => {
      const projectModule = "/src/platform/project.ts";
      const schemaModule = "/src/features/settings/model/schema.ts";
      const [{ useProject }, { DEFAULT_SETTINGS }] = await Promise.all([
        import(/* @vite-ignore */ projectModule),
        import(/* @vite-ignore */ schemaModule),
      ]);
      const base = useProject.getState().settings ?? DEFAULT_SETTINGS;
      useProject.setState({ settings: { ...base, editor: { ...base.editor, fontSize: 17 } } });
      window.__ipc.handlers.lsp_prepare_rename = () => prepared;
      window.__ipc.handlers.lsp_rename = (args) => ({
        preview: true,
        incomplete: null,
        edit: {
          files: [
            {
              kind: "edit",
              path: file,
              edits: [{ range: prepared, new_text: args.newName }],
            },
          ],
        },
      });
      window.__ipc.handlers.apply_workspace_edit = () => null;
    },
    { file: FILE, prepared: range(20, 12, 17) },
  );

  await caretAt(editor, page, "val order: Order", "order");
  await page.keyboard.press("Shift+F6");
  await expect(page.getByText(/Press ⇧F6 to show dialog/)).toBeVisible();
  const name = "checkoutOrderWithDeliveryInstructionsAndInventoryReservation";
  await page.keyboard.insertText(name);
  await page.keyboard.press("Shift+F6");
  await page.setViewportSize({ width: 440, height: 520 });
  const dialog = page.getByRole("dialog", { name: "Rename 'order'", exact: true });
  const input = dialog.getByRole("textbox", { name: "New name" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(name);
  await expect(input).toHaveCSS("font-size", "17px");
  const [label, field] = await Promise.all([
    dialog.getByText("New name", { exact: true }).boundingBox(),
    input.boundingBox(),
  ]);
  expect(label!.x + label!.width).toBeLessThan(field!.x);
  const rename = dialog.getByRole("button", { name: "Rename", exact: true });

  await input.fill("");
  await expect(rename).toBeDisabled();
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await ipcCalls(page, "lsp_rename")).toHaveLength(0);
  await input.fill(name);
  await input.press("Enter");

  const summary = `Rename 'order' to '${name}'`;
  const preview = page.getByRole("dialog", { name: summary, exact: true });
  const context = preview.getByText(summary, { exact: true });
  await expect(context).toBeVisible();
  const geometry = await context.evaluate((element) => ({
    client: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.client + 1);
  await expect(preview.getByText("1 occurrence in 1 file")).toBeVisible();
  expect(await ipcCalls(page, "apply_workspace_edit")).toHaveLength(0);
  await preview.getByRole("button", { name: "Do Refactor" }).click();
  await expect.poll(() => ipcCalls(page, "apply_workspace_edit")).toHaveLength(1);
});

test("intention previews fit narrow windows and wrap long code lines", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const editor = await openSample(page);
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const { settings } = useProject.getState();
    useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, fontSize: 16 } } });
  });
  await expect(editor.locator(".cm-content")).toHaveCSS("font-size", "16px");
  const replacement = "com.acme.orders." + "SharedDevelopmentOrderModel".repeat(6);
  await page.evaluate(
    ({ file, replacement, edit }) => {
      window.__ipc.handlers.lsp_code_actions = () => [
        {
          title: "Replace Order with the fully qualified shared development order model",
          kind: "quickfix",
          isPreferred: true,
          disabledReason: null,
          edit: { files: [{ kind: "edit", path: file, edits: [{ range: edit, new_text: replacement }] }] },
          command: null,
          data: null,
          server: 1,
        },
        ...Array.from({ length: 11 }, (_, i) => ({
          title: `Create alternative Order model ${i + 1}`,
          kind: "quickfix",
          isPreferred: false,
          disabledReason: null,
          edit: null,
          command: null,
          data: null,
          server: 1,
        })),
      ];
      window.__ipc.handlers.lsp_execute_code_action = () => [];
    },
    { file: FILE, replacement, edit: range(20, 19, 24) },
  );
  await caretAt(editor, page, "val order: Order", "Order ");
  await page.keyboard.press("Alt+Enter");
  const popup = page.getByRole("dialog", { name: "Intentions", exact: true });
  const options = popup.getByRole("listbox", { name: "Intentions" });
  const preview = popup.locator('[aria-label="Preview"]');
  await expect(preview.locator("pre")).toContainText(replacement);
  const wide = (await options.boundingBox())!;
  const widePreview = (await preview.boundingBox())!;
  expect(widePreview.x).toBeGreaterThanOrEqual(wide.x + wide.width - 1);

  await page.setViewportSize({ width: 1050, height: 900 });
  await expect
    .poll(async () => {
      const list = (await options.boundingBox())!;
      const code = (await preview.boundingBox())!;
      return code.x + code.width - list.x;
    })
    .toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 520, height: 540 });
  await expect
    .poll(async () => {
      const menu = (await popup.boundingBox())!;
      const list = (await options.boundingBox())!;
      const code = (await preview.boundingBox())!;
      return {
        popupFits: menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 521 && menu.y + menu.height <= 541,
        previewBelow: code.y >= list.y + list.height - 1,
        previewFits: code.x >= menu.x && code.x + code.width <= menu.x + menu.width + 1,
      };
    })
    .toEqual({ popupFits: true, previewBelow: true, previewFits: true });
  expect(await preview.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(preview.locator("pre")).toHaveCSS("font-size", "16px");
  await expect(options).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
});

test("diagnostics underline the range and ⌥⏎ applies the preferred quick fix", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, bad }) => {
      window.__ipc.handlers.lsp_code_actions = () => [
        {
          title: "Import 'com.acme.orders.model.Order'",
          kind: "quickfix",
          isPreferred: true,
          disabledReason: null,
          edit: {
            files: [
              {
                kind: "edit",
                path: file,
                edits: [
                  {
                    range: { start: { line: 4, col: 0 }, end: { line: 4, col: 0 } },
                    new_text: "import com.acme.orders.model.Order\n",
                  },
                ],
              },
            ],
          },
          command: null,
          data: null,
          server: "kotlin",
        },
        {
          title: "Create class 'Order'",
          kind: "quickfix",
          isPreferred: false,
          disabledReason: null,
          edit: null,
          command: null,
          data: null,
          server: "kotlin",
        },
      ];
      window.__ipc.emit({
        type: "diagnostics",
        path: file,
        source: "kotlin",
        items: [
          { range: bad, severity: "error", message: "Unresolved reference: Order", source: "kotlin", code: null },
        ],
      });
    },
    { file: FILE, bad: range(20, 19, 24) },
  );
  const squiggle = editor.locator(".cm-lintRange-error");
  await expect(squiggle).toHaveText("Order");
  await caretAt(editor, page, "val order: Order", "Order ");
  await page.keyboard.press("Alt+Enter");
  const fix = page.getByRole("option", { name: /Import 'com\.acme\.orders\.model\.Order'/ });
  await expect(fix).toBeVisible();
  await expect(page.getByRole("option", { name: /Create class 'Order'/ })).toBeVisible();
  await fix.click();
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
  const [applied] = await ipcCalls(page, "lsp_execute_code_action");
  expect(applied).toMatchObject({ action: { title: "Import 'com.acme.orders.model.Order'" } });
});

test("⌥⏎ opens the list before a slow server answers, then fills it", async ({ workbench: page }) => {
  const editor = await openSample(page);
  await page.evaluate(
    ({ file, bad }) => {
      const action = {
        title: "Import 'com.acme.orders.model.Order'",
        kind: "quickfix",
        isPreferred: true,
        disabledReason: null,
        edit: {
          files: [
            {
              kind: "edit",
              path: file,
              edits: [
                {
                  range: { start: { line: 4, col: 0 }, end: { line: 4, col: 0 } },
                  new_text: "import com.acme.orders.model.Order\n",
                },
              ],
            },
          ],
        },
        command: null,
        data: null,
        server: "kotlin",
      };
      // The server's answer is held until the test releases it, so "the popup is up while the
      // server is still thinking" is a fact and not a race against a timer.
      window.__releaseActions = null;
      window.__ipc.handlers.lsp_code_actions = () =>
        new Promise((resolve) => {
          window.__releaseActions = () => resolve([action]);
        });
      window.__ipc.handlers.lsp_execute_code_action = () => [];
      window.__ipc.emit({
        type: "diagnostics",
        path: file,
        source: "kotlin",
        items: [
          { range: bad, severity: "error", message: "Unresolved reference: Order", source: "kotlin", code: null },
        ],
      });
    },
    { file: FILE, bad: range(20, 19, 24) },
  );
  await caretAt(editor, page, "val order: Order", "Order ");
  const popup = page.getByTestId("list-popup");
  await page.keyboard.press("Alt+Enter");
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("aria-busy", "true");
  expect(await ipcCalls(page, "lsp_code_actions")).toHaveLength(1);
  // Only now does the server answer.
  await page.evaluate(() => window.__releaseActions?.());
  const fix = page.getByRole("option", { name: /Import 'com\.acme\.orders\.model\.Order'/ });
  await expect(fix).toBeVisible();
  await expect(popup).not.toHaveAttribute("aria-busy", "true");
  await fix.click();
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
});

test("lazy plugin actions resolve only when invoked, never for their intention preview", async ({
  workbench: page,
}) => {
  const editor = await openSample(page);
  await page.evaluate(() => {
    const action = {
      title: "Choose translation file",
      kind: "quickfix",
      isPreferred: true,
      disabledReason: null,
      edit: null,
      command: null,
      data: { plugin: "test.interactive-actions", data: "pick", file: false },
      server: 0,
    };
    window.__ipc.handlers.lsp_code_actions = () => [action];
    window.__ipc.handlers.lsp_resolve_code_action = () => ({ ...action, data: null, edit: { files: [] } });
    window.__ipc.handlers.lsp_execute_code_action = () => [];
  });
  await editor.locator(".cm-line", { hasText: "val order: Order" }).click();
  await page.keyboard.press("Alt+Enter");
  const fix = page.getByRole("option", { name: "Choose translation file", exact: true });
  await expect(fix).toBeVisible();
  await fix.hover();
  await expect(page.getByText("Preview isn't available for this action", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "lsp_resolve_code_action")).toHaveLength(0);
  expect(await ipcCalls(page, "lsp_execute_code_action")).toHaveLength(0);
  await fix.click();
  await expect.poll(() => ipcCalls(page, "lsp_resolve_code_action")).toHaveLength(1);
  await expect.poll(() => ipcCalls(page, "lsp_execute_code_action")).toHaveLength(1);
  const [applied] = await ipcCalls(page, "lsp_execute_code_action");
  expect(applied).toMatchObject({ action: { title: "Choose translation file", edit: { files: [] } } });
});
