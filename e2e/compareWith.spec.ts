/**
 * IDEA's Compare With…: project tree (git and non-git projects alike), the
 * editor content menu and the editor tab menu. Outside the desktop app the OS
 * dialog is replaced by a browser file picker and the chosen file is compared
 * as text.
 */
import { expect, openFromTree, test } from "./fixtures";

test("project tree menu offers Compare With… for a file", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  // The accessible name carries the shortcut: "Compare With… ⌘D".
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("editor tab menu offers Compare With…", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await page
    .getByRole("tablist", { name: "Editor tabs" })
    .getByRole("tab", { name: "README.md" })
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("editor menu offers Compare With…", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare With…/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Compare with Clipboard", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Compare With… compares against a file picked in the browser", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click({ button: "right" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /^Compare With…/ }).click();
  await (await chooser).setFiles({ name: "other.md", mimeType: "text/markdown", buffer: Buffer.from("other text\n") });
  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(tabs.getByRole("tab", { name: /other\.md/ })).toBeVisible({ timeout: 15_000 });
});

for (const fragment of [false, true]) {
  test(`clipboard comparison labels the ${fragment ? "selection" : "file"} and its origin`, async ({
    workbench: page,
  }) => {
    await page.evaluate(async (fragment) => {
      const path = "/dev/acme-api/src/estimate.ts";
      const source = "const estimate = 4;\nconst total = estimate + 1;\n";
      const backend = "/src/editor/core/backend.ts";
      (await import(/* @vite-ignore */ backend)).docBackend().files.set(path, source);
      const service = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
      const editor = "/src/editor/api.ts";
      const { view } = (await import(/* @vite-ignore */ editor)).activeEditor()!;
      view.dispatch({ selection: { anchor: 0, head: fragment ? source.indexOf("\n") : 0 } });
      view.focus();
      Object.defineProperty(navigator, "clipboard", {
        value: { readText: async () => "const estimate = 3;\n" },
        configurable: true,
      });
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "split", collapse: false }));
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("diff.compareWithClipboard");
    }, fragment);

    const toolbar = page.getByRole("toolbar", { name: "Diff", exact: true });
    const viewer = toolbar.locator("..");
    const file = fragment ? "Selection from estimate.ts" : "estimate.ts";
    const caption = viewer.getByTitle(`${file} src`, { exact: true });
    const clipboard = viewer.getByTitle("From Clipboard", { exact: true });
    await expect(clipboard).toBeVisible();
    await expect(caption.getByText("src", { exact: true })).toBeVisible();
    await expect(caption.getByText(file, { exact: true })).toHaveCSS("font-size", "13px");
    await expect(caption.getByText("src", { exact: true })).toHaveCSS("font-size", "12px");
    const sides = viewer.locator(".cm-content");
    await expect(sides.first()).toContainText("const estimate = 3;");
    await expect(sides.last()).toContainText("const estimate = 4;");
    const remainingLine = sides.last().getByText("const total =", { exact: false });
    if (fragment) await expect(remainingLine).toBeHidden();
    else await expect(remainingLine).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Editor tabs" });
    const title = `Clipboard ↔ estimate.ts${fragment ? " (selection)" : ""}`;
    await expect(tabs.getByRole("tab", { name: title, exact: true })).toBeVisible();

    await toolbar.getByRole("button", { name: "Swap Sides", exact: true }).click();
    await expect(caption).toBeVisible();
    expect((await caption.boundingBox())!.x).toBeLessThan((await clipboard.boundingBox())!.x);
    await toolbar.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Unified Viewer", exact: true }).click();
    await expect(viewer.getByTitle(`${file} src → From Clipboard`, { exact: true })).toBeVisible();
  });
}
