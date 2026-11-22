import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

test("opens a file from the project tree and types into it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// typed by e2e");
  await expect(editor.locator(".cm-content")).toContainText("// typed by e2e");
  // Undo removes the typing again.
  await page.keyboard.press("Meta+z");
  await expect(editor.locator(".cm-content")).not.toContainText("// typed by e2e");
});

test("indentation shows the language and current width with room for the keyboard choices", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await page.evaluate(async () => {
    const path = "/src/editor/core/controller.ts";
    const { editorController, useEditorStatus } = await import(/* @vite-ignore */ path);
    const active = useEditorStatus.getState().status!.path;
    editorController().manager.get(active)!.setIndent({ tabSize: 3, insertSpaces: true });
  });

  const status = page.getByRole("button", { name: "3 spaces", exact: true });
  await status.click();
  const menu = page.getByRole("menu", { name: "Indentation", exact: true });
  const title = page.getByText("Kotlin Code Style", { exact: true });
  await expect(title).toBeVisible();
  await page.setViewportSize({ width: 500, height: 520 });
  await expect(title).toBeInViewport({ ratio: 1 });
  await expect(title).toHaveCSS("font-size", "13px");
  await expect(title).toHaveCSS("font-weight", "600");
  await expect(menu.getByRole("menuitemcheckbox", { name: "3 spaces", checked: true })).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("menuitem", { name: "Configure Indents…" })).toBeInViewport({ ratio: 1 });

  await expect(menu.getByRole("menuitemcheckbox", { name: "2 spaces", checked: false })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const four = page.getByRole("button", { name: "4 spaces", exact: true });
  await expect(four).toBeVisible();
  await four.click();
  await expect(menu.getByRole("menuitemcheckbox", { name: "4 spaces", checked: true })).toBeVisible();
});

test("Delete edits text after the focused Project tree is remounted", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.press("Meta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("delete probe abc");
  const line = editor.locator(".cm-line", { hasText: "delete probe" });
  await expect(line).toHaveText("delete probe abc");

  const tree = page.getByRole("tree", { name: "Project" });
  await tree.focus();
  await page.evaluate(async () => {
    const keymapModule = "/src/platform/keymap.ts";
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const { applyKeymapSettings } = await import(/* @vite-ignore */ keymapModule);
    const { moveToolWindow } = await import(/* @vite-ignore */ layoutModule);
    applyKeymapSettings("intellij-windows", {});
    moveToolWindow("project", "right");
  });
  await expect(page.locator('[data-toolwindow="project"]')).toBeVisible();
  await expect(tree).not.toBeFocused();

  await content.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await expect(line).toHaveText("delete probe ab");
  await page.keyboard.press("Backspace");
  await expect(line).toHaveText("delete probe a");
});

test("⌘F opens the find bar and highlights matches; Escape returns to the editor", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find" });
  await expect(find).toBeFocused();
  await find.fill("Order");
  await expect(editor.locator(".cm-openidea-findMatch").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await expect(editor.locator(".cm-content")).toBeFocused();
});

test("Go to Line keeps its label beside the selected coordinates and returns focus to the editor", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const content = editor.locator(".cm-content");
  await content.focus();
  await page.keyboard.press("Meta+l");
  const dialog = page.getByRole("dialog", { name: "Go to Line:Column", exact: true });
  const coordinates = dialog.getByRole("textbox", { name: "Line and column", exact: true });
  await expect(coordinates).toBeFocused();
  await expect(coordinates).toHaveValue("1:1");
  expect(await coordinates.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 3]);

  await page.setViewportSize({ width: 360, height: 500 });
  const label = dialog.getByText("Line and column", { exact: true });
  await expect(label).toBeVisible();
  const text = (await label.boundingBox())!;
  const field = (await coordinates.boundingBox())!;
  expect(text.x + text.width).toBeLessThan(field.x);
  expect(Math.abs(text.y + text.height / 2 - field.y - field.height / 2)).toBeLessThan(2);
  await expect(coordinates).toHaveCSS("font-size", await label.evaluate((el) => getComputedStyle(el).fontSize));

  await coordinates.fill("0:2");
  await expect(coordinates).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
  await coordinates.fill("6:8");
  await coordinates.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(content).toBeFocused();
  await page.setViewportSize({ width: 960, height: 600 });
  await expect(page.getByRole("button", { name: "6:8", exact: true })).toBeVisible();
});

test("each file keeps its own find bar, query and caret", async ({ workbench: page }) => {
  const find = page.getByRole("textbox", { name: "Find" });
  const caret = page.getByRole("button", { name: /^\d+:\d+/ });
  const tab = (name: string) => page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name });

  const a = await openFromTree(page, "build.gradle.kts");
  await a.locator(".cm-content").click();
  await page.keyboard.press("Meta+f");
  await find.fill("Order");
  await expect(caret).toHaveText(/\(5 chars\)/);
  const caretA = await caret.textContent();

  // Another file has no bar until ⌘F; opening one starts from the last search without moving the caret.
  const b = await openFromTree(page, "settings.gradle.kts");
  await expect(find).toBeHidden();
  await b.locator(".cm-line", { hasText: "@PostMapping" }).click();
  const caretB = await caret.textContent();
  await page.keyboard.press("Meta+f");
  await expect(find).toHaveValue("Order");
  await expect(caret).toHaveText(caretB!);
  await find.fill("status");
  await expect(caret).toHaveText(/\(6 chars\)/);
  const caretB2 = await caret.textContent();

  // A third file starts from the latest search.
  await openFromTree(page, "README.md");
  await expect(find).toBeHidden();
  await page.keyboard.press("Meta+f");
  await expect(find).toHaveValue("status");

  // Switching back shows each file's own query, caret untouched.
  await tab("build.gradle.kts").click();
  await expect(find).toHaveValue("Order");
  await expect(caret).toHaveText(caretA!);
  await tab("settings.gradle.kts").click();
  await expect(find).toHaveValue("status");
  await expect(caret).toHaveText(caretB2!);
  await find.press("Escape");
  await expect(find).toBeHidden();
  await tab("build.gradle.kts").click();
  await expect(find).toHaveValue("Order");
});

test("opening several files creates tabs and ⌘W closes the active one", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await openFromTree(page, "settings.gradle.kts");
  const tabs = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await page.locator(".cm-editor .cm-content").first().click();
  await page.keyboard.press("Meta+w");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/build\.gradle\.kts/);
});

test("breadcrumbs follow the caret into the symbol under it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const status = page.getByRole("navigation", { name: "Breadcrumbs", exact: true });
  const code = page.getByRole("navigation", { name: "Code breadcrumbs" });
  await editor.locator(".cm-line", { hasText: "service.find(status" }).click();
  await expect(status).toContainText("list()");
  await expect(code).toContainText("OrderController");
  await expect(code).toContainText("list()");
  // Typing inside the method keeps its crumb.
  await page.keyboard.press("Home");
  await page.keyboard.type("checked ");
  await expect(code).toContainText("list()");
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await expect(code).toContainText("create()");
  await expect(code).not.toContainText("list()");
  await expect(status).toContainText("create()");
  // ⌘↑ opens the navigation bar at the caret's symbol.
  await page.keyboard.press("Meta+ArrowUp");
  const bar = page.getByRole("toolbar", { name: "Navigation bar" });
  await expect(bar).toContainText("create()");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("narrow breadcrumb bars keep the current symbol visible and allow opening earlier crumbs", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const path = page.getByRole("navigation", { name: "Breadcrumbs", exact: true });
  const code = page.getByRole("navigation", { name: "Code breadcrumbs" });
  await editor.locator(".cm-line", { hasText: "service.find(status" }).click();
  await expect(code).toContainText("list()");

  await page.evaluate(async () => {
    const documentModule = "/src/editor/core/model/document.ts";
    const editorModule = "/src/editor/core/controller.ts";
    const projectModule = "/src/platform/project.ts";
    const schemaModule = "/src/features/settings/model/schema.ts";
    const [{ useOutline }, { useEditorStatus }, { useProject }, { DEFAULT_SETTINGS }] = await Promise.all([
      import(/* @vite-ignore */ documentModule),
      import(/* @vite-ignore */ editorModule),
      import(/* @vite-ignore */ projectModule),
      import(/* @vite-ignore */ schemaModule),
    ]);
    const base = useProject.getState().settings ?? DEFAULT_SETTINGS;
    useProject.setState({ settings: { ...base, editor: { ...base.editor, fontSize: 17 } } });
    const activePath = useEditorStatus.getState().status.path;
    let outline = useOutline.getState()[activePath];
    for (const name of ["OrderProcessingStrategies", "SalesApplicationRouting", "CheckoutWorkspaceConfiguration"]) {
      outline = [{ ...outline[0], name, detail: null, children: outline }];
    }
    useOutline.setState({ [activePath]: outline });
  });

  await page.setViewportSize({ width: 620, height: 620 });
  const fullyInBar = (bar: typeof path, label: string) =>
    bar.evaluate((nav, text) => {
      const crumb = [...nav.querySelectorAll("button")].find((button) => button.textContent === text);
      if (!crumb) return false;
      const { left, right } = nav.getBoundingClientRect();
      const rect = crumb.getBoundingClientRect();
      return rect.width > 0 && rect.left >= left - 1 && rect.right <= right + 1;
    }, label);
  for (const bar of [path, code]) {
    await expect.poll(() => fullyInBar(bar, "list()")).toBe(true);
    await expect(bar.locator('[aria-current="location"]')).toHaveText("list()");
  }
  await expect(code.locator('[aria-current="location"]')).toHaveCSS("font-size", "17px");
  await code.hover();
  await page.mouse.wheel(0, -1200);
  await expect.poll(() => fullyInBar(code, "CheckoutWorkspaceConfiguration")).toBe(true);

  const current = path.locator('[aria-current="location"]');
  await current.focus();
  await current.press("Home");
  const project = path.getByRole("button", { name: /acme-api/ }).first();
  await expect(project).toBeFocused();
  await expect.poll(() => fullyInBar(path, "acme-api")).toBe(true);
  await project.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "acme-api" })).toBeVisible();
});

/** What the in-memory backend has saved for `path`. */
const saved = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const backendModule = "/src/editor/core/backend.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendModule);
    return (docBackend() as { files: Map<string, string> }).files.get(path) ?? null;
  }, path);

test("an edit marks the tab modified and ⌘S saves it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  // The only tab; its modified dot sits next to its close button.
  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(tabs.getByLabel("Modified")).toHaveCount(0);
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// saved by e2e");
  await expect(tabs.getByLabel("Modified")).toHaveCount(1);
  expect(await saved(page, "/dev/acme-api/build.gradle.kts")).toBeNull();
  await page.keyboard.press("Meta+s");
  await expect(tabs.getByLabel("Modified")).toHaveCount(0);
  expect(await saved(page, "/dev/acme-api/build.gradle.kts")).toContain("// saved by e2e");
});

test("⌘R replaces every match in the file", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+r");
  const bar = page.getByRole("search", { name: "Replace in file" });
  await bar.getByRole("textbox", { name: "Find" }).fill("OrderDto");
  await bar.getByRole("textbox", { name: "Replace" }).fill("OrderView");
  await bar.getByRole("button", { name: "Replace All" }).click();
  const content = editor.locator(".cm-content");
  await expect(content).not.toContainText("OrderDto");
  await expect(editor.locator(".cm-line", { hasText: "OrderView" })).toHaveCount(2);
  // One undo step takes the whole replacement back.
  await content.click();
  await page.keyboard.press("Meta+z");
  await expect(editor.locator(".cm-line", { hasText: "OrderDto" })).toHaveCount(2);
});

test("the inline find and replace fields share a column that grows with the editor", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+r");
  const bar = page.getByRole("search", { name: "Replace in file" });
  const find = bar.getByRole("textbox", { name: "Find" });
  const replace = bar.getByRole("textbox", { name: "Replace" });
  const more = bar.getByRole("button", { name: "More", exact: true });
  const close = bar.getByRole("button", { name: "Close", exact: true });
  await find.fill("OrderDto");
  await replace.fill("OrderView");

  const column = () =>
    bar.evaluate((panel) => {
      const [find, replace] = panel.querySelectorAll("textarea");
      const findField = find!.parentElement!.getBoundingClientRect();
      const replaceField = replace!.parentElement!.getBoundingClientRect();
      return {
        left: findField.left,
        width: findField.width,
        replaceLeft: replaceField.left,
        replaceWidth: replaceField.width,
      };
    });
  const initial = await column();
  expect(initial.left).toBeCloseTo(initial.replaceLeft);
  expect(initial.width).toBeCloseTo(initial.replaceWidth);

  for (const width of [1120, 1480]) {
    await page.setViewportSize({ width, height: 760 });
    const [moreBox, closeBox] = await Promise.all([more.boundingBox(), close.boundingBox()]);
    expect(closeBox!.y).toBeCloseTo(moreBox!.y);
    expect(closeBox!.x).toBeGreaterThanOrEqual(moreBox!.x + moreBox!.width);
    expect(closeBox!.x).toBeLessThanOrEqual(moreBox!.x + moreBox!.width + 4);
  }
  await expect.poll(async () => (await column()).width).toBeGreaterThan(initial.width + 60);
  await close.click();
  await expect(bar).toBeHidden();
});

test("the inline find and replace controls stay inside a narrow editor pane", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+r");
  const bar = page.getByRole("search", { name: "Replace in file" });
  const find = bar.getByRole("textbox", { name: "Find" });
  const replace = bar.getByRole("textbox", { name: "Replace" });
  const next = bar.getByRole("button", { name: /Next Occurrence/ });
  await find.fill("OrderDto");
  await find.press("Tab");
  await expect(replace).toBeFocused();
  await replace.fill("OrderView");
  const navigationIsBelowFind = async () => {
    const [input, button] = await Promise.all([find.boundingBox(), next.boundingBox()]);
    return !!input && !!button && button.y >= input.y + input.height;
  };
  const controlsFit = () =>
    bar.evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return [...panel.querySelectorAll("button, textarea")].every((element) => {
        const control = element.getBoundingClientRect();
        return control.width > 0 && control.left >= bounds.left && control.right <= bounds.right;
      });
    });
  await expect.poll(navigationIsBelowFind).toBe(false);

  await page.setViewportSize({ width: 590, height: 760 });
  await expect.poll(controlsFit).toBe(true);
  await expect.poll(navigationIsBelowFind).toBe(true);
  await page.setViewportSize({ width: 495, height: 760 });
  await expect.poll(controlsFit).toBe(true);
  const close = bar.getByRole("button", { name: "Close", exact: true });
  const more = bar.getByRole("button", { name: "More", exact: true });
  const [moreBox, closeBox] = await Promise.all([more.boundingBox(), close.boundingBox()]);
  expect(closeBox!.y).toBeCloseTo(moreBox!.y);
  expect(closeBox!.x).toBeGreaterThanOrEqual(moreBox!.x + moreBox!.width);
  expect(closeBox!.x).toBeLessThanOrEqual(moreBox!.x + moreBox!.width + 4);
  await expect(find).toHaveValue("OrderDto");
  await expect(replace).toHaveValue("OrderView");
  await next.click();
  await expect(bar.getByText(/^[12]\/2$/)).toBeVisible();
  await bar.getByRole("button", { name: "Replace All" }).click();
  await expect(editor.locator(".cm-line", { hasText: "OrderView" })).toHaveCount(2);
  await close.click();
  await expect(bar).toBeHidden();
});

test("Markdown preview highlights ⌘F matches, selected words and scales diagrams with font zoom", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96" width="320" height="96"><!-- svg-source:excalidraw --><rect width="320" height="96"/></svg>';
    const url = `data:image/svg+xml;base64,${btoa(svg)}`;
    const routeModule = "/src/platform/tauriCore.ts";
    const { setInvokeRoute } = await import(/* @vite-ignore */ routeModule);
    setInvokeRoute((cmd: string) => (cmd === "fs_read_image" ? Promise.resolve(url) : null));
  });

  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(
    [
      "# Order Service",
      "",
      "Manage **Order** items and `Order` status.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "![Diagram](./arch.excalidraw.svg)",
    ].join("\n"),
  );

  const preview = page.getByRole("document", { name: "Markdown preview" });
  await expect(preview).toContainText("Manage Order items");

  // Selecting a word in the preview auto-highlights its other occurrences in the preview and the split editor.
  await preview.locator("strong").dblclick();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const set = CSS.highlights.get("markdown-selection-match");
        return set ? [...set].map((r) => (r as Range).toString()) : [];
      }),
    )
    .toEqual(["Order", "Order"]);
  await expect(editor.locator(".cm-selectionMatch")).toHaveCount(3);

  // Pressing ⌘F seeds from the preview selection and highlights current + other matches in the preview.
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find" });
  await expect(find).toHaveValue("Order");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        current: [...(CSS.highlights.get("markdown-find-current") ?? [])].map((r) => (r as Range).toString()),
        other: [...(CSS.highlights.get("markdown-find") ?? [])].map((r) => (r as Range).toString()),
      })),
    )
    .toEqual({ current: ["Order"], other: ["Order", "Order"] });

  const mermaidSvg = preview.locator(".mermaid-output svg");
  const excalidrawImg = preview.locator('img[alt="Diagram"]');
  await expect(mermaidSvg).toBeVisible();
  await expect(excalidrawImg).toHaveAttribute("src", /^data:image\/svg\+xml/);

  const widths = async () => ({
    mermaid: (await mermaidSvg.boundingBox())!.width,
    excalidraw: (await excalidrawImg.boundingBox())!.width,
  });
  const base = await widths();
  expect(base.mermaid).toBeGreaterThan(50);
  expect(base.excalidraw).toBeCloseTo(320, 0);

  const runAction = (id: string, times = 1) =>
    page.evaluate(
      async ({ id, times }) => {
        const actionsModule = "/src/platform/actions.ts";
        const { executeAction } = await import(/* @vite-ignore */ actionsModule);
        for (let i = 0; i < times; i++) await executeAction(id);
      },
      { id, times },
    );

  await runAction("editor.increaseFontSize", 4);
  const zoomedIn = await widths();
  expect(zoomedIn.mermaid / base.mermaid).toBeCloseTo(17 / 13, 2);
  expect(zoomedIn.excalidraw / base.excalidraw).toBeCloseTo(17 / 13, 2);

  await runAction("editor.decreaseFontSize", 6);
  const zoomedOut = await widths();
  expect(zoomedOut.mermaid / base.mermaid).toBeCloseTo(11 / 13, 2);
  expect(zoomedOut.excalidraw / base.excalidraw).toBeCloseTo(11 / 13, 2);

  await runAction("editor.resetFontSize");
  const reset = await widths();
  expect(reset.mermaid).toBeCloseTo(base.mermaid, 1);
  expect(reset.excalidraw).toBeCloseTo(base.excalidraw, 1);
});

test("Markdown preview keeps following find and edits after scrolling the source", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  const preview = page.getByRole("document", { name: "Markdown preview" });
  await content.click();
  await page.keyboard.press("Meta+a");
  const spacer = Array.from({ length: 90 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
  await page.keyboard.insertText(`First needle\n\n${spacer}\n\nSecond needle\n\n${spacer}\n\nThird needle`);
  await content.press("Control+Home");
  await expect(preview).toContainText("Third needle");
  await editor.locator(".cm-scroller").evaluate((el) => (el.scrollTop = 2000));
  await expect.poll(() => preview.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await preview.focus();
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find" });
  await find.fill("needle");
  const visibleMatch = () =>
    preview.evaluate((el) => {
      const match = (CSS.highlights.get("markdown-find-current") as unknown as Set<Range> | undefined)
        ?.values()
        .next().value;
      if (!match) return null;
      const box = el.getBoundingClientRect();
      const range = match.getBoundingClientRect();
      return range.top >= box.top && range.bottom <= box.bottom ? match.startContainer.textContent : null;
    });
  await expect.poll(visibleMatch).toBe("First needle");
  await find.press("ArrowDown");
  await expect.poll(visibleMatch).toBe("Second needle");
  await find.press("ArrowDown");
  await expect.poll(visibleMatch).toBe("Third needle");
  await find.press("ArrowUp");
  await expect.poll(visibleMatch).toBe("Second needle");

  await find.press("Escape");
  await content.focus();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("- **$`v_0`$ Flat wings.**");
  await expect(preview.locator("strong [data-math-svg] > svg")).toHaveAttribute("aria-label", "v_0");
});

test("Markdown preview aligns Mermaid diagrams to their container align attribute", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  const diagram = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");
  await page.keyboard.insertText(
    [
      diagram,
      "",
      '<div align="left" style="width: 960px; max-width: 100%; margin-left: 0; text-align: left;">',
      "",
      diagram,
      "",
      "</div>",
      "",
      '<div align="right">',
      "",
      diagram,
      "",
      "</div>",
      "",
      '<div align="left"><div align="center">',
      "",
      diagram,
      "",
      "</div></div>",
    ].join("\n"),
  );

  const preview = page.getByRole("document", { name: "Markdown preview" });
  const outputs = preview.locator("[data-mermaid-state='ok'] .mermaid-output");
  await expect(outputs).toHaveCount(4);

  const offsets = await outputs.evaluateAll((els) =>
    els.map((out) => {
      const outRect = out.getBoundingClientRect();
      const svgRect = out.querySelector("svg")!.getBoundingClientRect();
      return {
        leftGap: svgRect.left - outRect.left,
        rightGap: outRect.right - svgRect.right,
      };
    }),
  );

  expect(offsets[0]!.leftGap).toBeGreaterThan(20);
  expect(Math.abs(offsets[0]!.leftGap - offsets[0]!.rightGap)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(offsets[1]!.leftGap)).toBeLessThanOrEqual(1);
  expect(offsets[1]!.rightGap).toBeGreaterThan(40);
  expect(offsets[2]!.leftGap).toBeGreaterThan(40);
  expect(Math.abs(offsets[2]!.rightGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(offsets[3]!.leftGap - offsets[3]!.rightGap)).toBeLessThanOrEqual(1.5);
});

test("the bookmark gutter takes no width until the file has a bookmark", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const column = editor.locator(".cm-gutter.cm-openidea-bookmarks");
  const width = () => column.evaluate((el) => el.getBoundingClientRect().width);
  await expect.poll(width).toBe(0);

  await editor.locator(".cm-content").click();
  await page.keyboard.press("F3");
  await expect(column.locator(".cm-openidea-bookmark")).toBeVisible();
  await expect.poll(width).toBeGreaterThan(0);
});

test("single-line selection stays on its own row when font glyphs exceed line height", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const schemaModule = "/src/features/settings/model/schema.ts";
    const [{ useProject }, { DEFAULT_SETTINGS }] = await Promise.all([
      import(/* @vite-ignore */ projectModule),
      import(/* @vite-ignore */ schemaModule),
    ]);
    const base = useProject.getState().settings ?? DEFAULT_SETTINGS;
    useProject.setState({
      settings: { ...base, editor: { ...base.editor, fontSize: 20, lineHeight: 22 } },
    });
    await document.fonts.ready;
  });

  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("- Build desktop bundle\n- Run integration suite\n---");

  const targetLine = editor.locator(".cm-line", { hasText: "Run integration suite" });
  await expect(targetLine).toBeVisible();
  await targetLine.dblclick();

  const sel = editor.locator(".cm-openidea-selectionLayer .cm-selectionBackground");
  await expect(sel).toHaveCount(1);
  const [lineBox, selBox] = await Promise.all([targetLine.boundingBox(), sel.boundingBox()]);
  expect(lineBox).not.toBeNull();
  expect(selBox).not.toBeNull();
  expect(Math.abs(selBox!.y - lineBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(selBox!.height - lineBox!.height)).toBeLessThanOrEqual(1);
});

test("vertical tabs leave a narrow editor group most of its width", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openFromTree(page, "settings.gradle.kts");
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const schemaModule = "/src/features/settings/model/schema.ts";
    const controllerModule = "/src/editor/core/controller.ts";
    const [{ useProject }, { DEFAULT_SETTINGS }, { editorController, useTabs }] = await Promise.all([
      import(/* @vite-ignore */ projectModule),
      import(/* @vite-ignore */ schemaModule),
      import(/* @vite-ignore */ controllerModule),
    ]);
    const base = useProject.getState().settings ?? DEFAULT_SETTINGS;
    useProject.setState({
      settings: { ...base, editor: { ...base.editor, tabs: { ...base.editor.tabs, placement: "left" } } },
    });
    editorController().split(useTabs.getState().activePane, "row");
  });

  const panes = page.locator("[data-pane-id]");
  await expect(panes).toHaveCount(2);
  for (const pane of await panes.all()) {
    const strip = pane.getByRole("tablist", { name: "Editor tabs" });
    await expect(strip).toHaveAttribute("aria-orientation", "vertical");
    const [paneBox, contentBox] = await Promise.all([pane.boundingBox(), pane.getByRole("tabpanel").boundingBox()]);
    expect(contentBox!.width).toBeGreaterThanOrEqual(paneBox!.width * 0.6 - 1);
  }
});

test("dragging the vertical tab column's edge resizes it and the width is kept", async ({ workbench: page }) => {
  await openFromTree(page, "settings.gradle.kts");
  const placeLeft = () =>
    page.evaluate(async () => {
      const projectModule = "/src/platform/project.ts";
      const schemaModule = "/src/features/settings/model/schema.ts";
      const [{ useProject }, { DEFAULT_SETTINGS }] = await Promise.all([
        import(/* @vite-ignore */ projectModule),
        import(/* @vite-ignore */ schemaModule),
      ]);
      const base = useProject.getState().settings ?? DEFAULT_SETTINGS;
      useProject.setState({
        settings: { ...base, editor: { ...base.editor, tabs: { ...base.editor.tabs, placement: "left" } } },
      });
    });
  await placeLeft();

  const strip = page.getByRole("tablist", { name: "Editor tabs" });
  const handle = page.getByRole("separator", { name: "Resize editor tabs" });
  const before = (await strip.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await strip.boundingBox())!.width).toBeLessThan(before - 40);
  const narrowed = (await strip.boundingBox())!.width;

  // The next session starts with the dragged width.
  await page.reload();
  await openFromTree(page, "settings.gradle.kts");
  await placeLeft();
  await expect.poll(async () => Math.round((await strip.boundingBox())!.width)).toBe(Math.round(narrowed));
});

test("dragging the Markdown split divider resizes and reflows editor and preview content, keeps the ratio, and resets on double-click", async ({
  workbench: page,
}) => {
  const applyDefaultSettings = () =>
    page.evaluate(async () => {
      const projectModule = "/src/platform/project.ts";
      const schemaModule = "/src/features/settings/model/schema.ts";
      const [{ useProject }, { DEFAULT_SETTINGS }] = await Promise.all([
        import(/* @vite-ignore */ projectModule),
        import(/* @vite-ignore */ schemaModule),
      ]);
      useProject.setState({ settings: useProject.getState().settings ?? DEFAULT_SETTINGS });
    });
  await applyDefaultSettings();

  const editor = await openFromTree(page, "README.md");
  await page.evaluate(async () => {
    const controllerModule = "/src/editor/core/controller.ts";
    const { editorController } = await import(/* @vite-ignore */ controllerModule);
    const view = editorController().activeSlot!.view!;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: [
          "# Order Service",
          "",
          "Event-driven order processing API with idempotent checkout, inventory reservation, webhook delivery, and automatic retry policies.",
          "",
          "| Method | Path | Description |",
          "| :--- | :--- | :--- |",
          "| `POST` | `/v1/orders/{id}/cancel` | Release reserved stock and emit cancellation event |",
        ].join("\n"),
      },
      selection: { anchor: 0 },
    });
  });

  const preview = page.getByRole("document", { name: "Markdown preview" });
  const handle = page.getByRole("separator", { name: "Resize Markdown preview" });
  const cmContent = editor.locator(".cm-content");
  await expect(preview).toContainText("Event-driven order processing API");
  await expect(handle).toBeVisible();
  await expect(cmContent).toHaveClass(/cm-lineWrapping/);

  const initialEditor = (await editor.boundingBox())!.width;
  const initialPreview = (await preview.boundingBox())!.width;
  const initialContent = (await cmContent.boundingBox())!.width;
  expect(Math.abs(initialEditor - initialPreview)).toBeLessThanOrEqual(2);
  expect(initialContent).toBeLessThanOrEqual(initialEditor);

  const box = (await handle.boundingBox())!;
  const startX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  const cursorAt = (x: number) =>
    page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x, y: midY });

  await page.mouse.move(startX + 40, midY);
  await page.mouse.move(startX, midY);
  expect(await cursorAt(startX)).toMatch(/resize$/);
  await page.mouse.move(startX - 5, midY);
  expect(await cursorAt(startX - 5)).not.toMatch(/resize$/);

  await page.mouse.move(startX, midY);
  await page.mouse.down();
  await page.mouse.move(startX - 180, midY, { steps: 6 });
  await expect(handle).toHaveAttribute("data-separator", "active");
  const sourceX = (await editor.boundingBox())!.x + 60;
  expect(await cursorAt(sourceX)).toMatch(/resize$/);
  await page.mouse.up();
  await page.mouse.move(sourceX, midY);
  expect(await cursorAt(sourceX)).toBe("text");

  await expect.poll(async () => (await editor.boundingBox())!.width).toBeLessThan(initialEditor - 150);
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThan(initialPreview + 150);
  const narrowedEditor = (await editor.boundingBox())!.width;
  // Soft-wrapped editor content shrinks with the narrowed editor pane rather than overflowing.
  await expect.poll(async () => (await cmContent.boundingBox())!.width).toBeLessThanOrEqual(narrowedEditor);

  // Dragging right narrows the preview: table and prose stay within the preview content width.
  const narrowedHandleBox = (await handle.boundingBox())!;
  await page.mouse.move(narrowedHandleBox.x + narrowedHandleBox.width / 2, midY);
  await page.mouse.down();
  await page.mouse.move(narrowedHandleBox.x + narrowedHandleBox.width / 2 + 380, midY, { steps: 8 });
  await page.mouse.up();
  const widenedEditor = (await editor.boundingBox())!.width;
  await expect.poll(async () => (await cmContent.boundingBox())!.width).toBeGreaterThan(initialContent + 140);
  await expect.poll(async () => (await cmContent.boundingBox())!.width).toBeLessThanOrEqual(widenedEditor);
  expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Editor Only and Preview Only both expand content to full pane width.
  await page.getByRole("button", { name: "Editor Only" }).click();
  await expect.poll(async () => (await cmContent.boundingBox())!.width).toBeGreaterThan(widenedEditor);
  await page.getByRole("button", { name: "Preview Only" }).click();
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThan(initialPreview * 1.8);
  await page.getByRole("button", { name: "Editor and Preview" }).click();
  await expect.poll(async () => Math.round((await editor.boundingBox())!.width)).toBe(Math.round(widenedEditor));

  // Persists across reload.
  await page.reload();
  await applyDefaultSettings();
  const reopenedEditor = await openFromTree(page, "README.md");
  await expect
    .poll(async () => Math.round((await reopenedEditor.boundingBox())!.width))
    .toBe(Math.round(widenedEditor));

  // Double-clicking the divider resets the split back to 50/50.
  const reopenedHandle = page.getByRole("separator", { name: "Resize Markdown preview" });
  await reopenedHandle.dblclick();
  await expect
    .poll(async () => Math.round((await reopenedEditor.boundingBox())!.width))
    .toBe(Math.round(initialEditor));
});

test("Markdown Preview only leaves the Project view clickable", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await page.getByRole("button", { name: "Preview Only" }).click();
  await expect(page.getByRole("document", { name: "Markdown preview" })).toBeVisible();

  const row = page.getByRole("treeitem", { name: "build.gradle.kts", exact: true });
  // A hidden editor panel used to leave an implicit resize region over everything left of the preview,
  // which swallowed the click.
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
});

test("drags selected text to move it, and copies it with Option held", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const content = editor.locator(".cm-content");
  /** Sets the document and selection, and returns the client point of each requested position. */
  const prepare = (doc: string, from: number, to: number, points: number[]) =>
    content.evaluate(
      async (el, { doc, from, to, points }) => {
        const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
        const { EditorView } = await import(/* @vite-ignore */ viewModule);
        const view = EditorView.findFromDOM(el as HTMLElement)!;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: doc },
          selection: { anchor: from, head: to },
        });
        view.focus();
        return points.map((p) => {
          const c = view.coordsAtPos(p, 1)!;
          return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
        });
      },
      { doc, from, to, points },
    );
  const docText = () =>
    content.evaluate(async (el) => {
      const viewModule = "/node_modules/.vite/deps/@codemirror_view.js";
      const { EditorView } = await import(/* @vite-ignore */ viewModule);
      return EditorView.findFromDOM(el as HTMLElement)!.state.doc.toString();
    });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, copy = false) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 2, { steps: 2 });
    // Option is pressed once the drag is under way: Option+press itself starts a column selection.
    if (copy) await page.keyboard.down("Alt");
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await expect(editor.locator(".cm-openidea-textDropLayer .cm-dropCursor")).toHaveCount(1);
    await page.mouse.up();
    if (copy) await page.keyboard.up("Alt");
  };

  // "alpha" (0–5) dragged to the start of the third line.
  let [grab, target] = await prepare("alpha beta\ngamma\ndelta", 0, 5, [2, 17]);
  await drag(grab!, target!);
  await expect.poll(docText).toBe(" beta\ngamma\nalphadelta");
  await expect(editor.locator(".cm-openidea-textDropLayer .cm-dropCursor")).toHaveCount(0);

  // With Option held, the text is copied instead.
  [grab, target] = await prepare("alpha beta\ngamma\ndelta", 0, 5, [2, 17]);
  await drag(grab!, target!, true);
  await expect.poll(docText).toBe("alpha beta\ngamma\nalphadelta");

  // A click on the selection without dragging places the caret there.
  [grab] = await prepare("alpha beta", 0, 5, [2]);
  await page.mouse.click(grab!.x, grab!.y);
  await expect.poll(docText).toBe("alpha beta");
  await page.keyboard.type("X");
  await expect.poll(docText).toBe("alXpha beta");
});
