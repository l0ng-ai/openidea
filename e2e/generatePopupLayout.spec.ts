import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("Generate fits its actions and keeps keyboard filtering at a narrow width", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 570, height: 600 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.lsp_code_actions = () =>
      [
        ["Generate Constructor", "refactor"],
        ["Generate Getter", "refactor"],
        ["Generate Setter", "refactor"],
        ["Create a unit test", "source.addTest"],
        ["Organize Imports", "source.organizeImports"],
      ].map(([title, kind]) => ({
        title,
        kind,
        isPreferred: false,
        disabledReason: null,
        edit: null,
        command: { command: "fixture.generate", arguments: [] },
        data: null,
        server: "kotlin",
      }));
    window.__ipc.handlers.lsp_resolve_command = () => null;
    window.__ipc.handlers.lsp_execute_code_action = () => [];
  });
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("Meta+n");

  const popup = page.getByRole("dialog", { name: "Generate", exact: true });
  const options = popup.getByRole("option");
  await expect(options).toHaveText([
    "Generate Constructor",
    "Generate Getter",
    "Generate Setter",
    "Create a unit test",
  ]);
  await expect(popup).toBeInViewport({ ratio: 1 });
  const width = (await popup.boundingBox())!.width;
  expect(width).toBeLessThan(300);
  const icons = await options.locator("svg").evaluateAll((elements) => elements.map((el) => el.innerHTML));
  expect(new Set(icons).size).toBe(3);

  await expect(popup.getByRole("listbox")).toBeFocused();
  await page.keyboard.type("sett");
  await expect(options).toHaveText(["Generate Setter"]);
  expect((await popup.boundingBox())!.width).toBe(width);
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await expect
    .poll(() => ipcCalls(page, "lsp_execute_code_action"))
    .toMatchObject([{ action: { title: "Generate Setter" } }]);
});
