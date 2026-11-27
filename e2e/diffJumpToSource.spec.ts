import { expect, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test("opens the working file with Command+Down after a revision diff loads its source", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/README.md";
    const probe = new Promise((resolve) => {
      window.__ipc.handlers.complete_probe = () => resolve({ size: 48, binary: false, tooLarge: false });
    });
    window.__ipc.handlers.fs_probe = ({ path: candidate }) => (candidate === path ? probe : null);
    window.__ipc.handlers.fs_read_text = () => "# Acme API\n\nWorking copy\n";
    const keymap = "/src/platform/keymap.ts";
    (await import(/* @vite-ignore */ keymap)).applyKeymapSettings("intellij-macos", {});
    const actions = "/src/platform/actions.ts";
    await (
      await import(/* @vite-ignore */ actions)
    ).executeAction("diff.compareTexts", {
      path,
      left: { text: "# Acme API\n\nPrevious commit\n", label: "Parent" },
      right: { text: "# Acme API\n\nNew commit\n", label: "Commit" },
    });
  });

  const pane = page.locator(".cm-merge-b .cm-content");
  await pane.click();
  await expect(pane).toBeFocused();
  const jump = page.getByRole("button", { name: "Jump to Source", exact: true });
  await expect(jump).toHaveCount(0);
  await page.evaluate(() => window.__ipc.handlers.complete_probe!({}));
  await expect(jump).toBeVisible();
  await expect(pane).toBeFocused();

  await page.keyboard.press("Meta+ArrowDown");
  await page.screenshot({ path: test.info().outputPath("jump-to-source.png"), animations: "disabled" });
  await expect(page.getByRole("tab", { name: "README.md", exact: true, selected: true })).toBeVisible();
  await expect(pane).toBeHidden();
});
