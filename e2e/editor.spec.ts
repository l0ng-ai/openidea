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

test("Markdown preview highlights ⌘F matches and selected word occurrences", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText("# Order Service\n\nManage **Order** items and `Order` status.\n");

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
