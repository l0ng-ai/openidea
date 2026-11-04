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
