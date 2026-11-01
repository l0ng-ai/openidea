import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

const source = readFileSync("fixtures/astro-app/src/pages/index.astro", "utf8");

test("opens and reopens Astro with mixed highlighting and the correct file type", async ({
  workbench: page,
}, testInfo) => {
  const open = () =>
    page.evaluate(async (text) => {
      const backendPath = "/src/editor/core/backend.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const { docBackend } = await import(backendPath);
      const { editorService } = await import(contributionsPath);
      docBackend().files.set("/dev/acme-api/index.astro", text);
      await editorService().openFile("/dev/acme-api/index.astro");
    }, source);
  await open();
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).toContainText("interface Props");
  const fileType = page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: "File Type" });
  await expect(fileType).toHaveText("Astro");
  for (const text of ["import", "interface", "color"]) {
    await expect(
      editor
        .locator(".cm-line span")
        .filter({ hasText: new RegExp(`^${text}$`) })
        .first(),
    ).toBeVisible();
  }
  const editorShot = testInfo.outputPath("astro-editor.png");
  await page.screenshot({ path: editorShot, animations: "disabled" });
  await testInfo.attach("Astro editor (browser preview)", { path: editorShot, contentType: "image/png" });
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+w");
  await expect(fileType).toBeHidden();
  await open();
  await expect(fileType).toHaveText("Astro");
  await fileType.click();
  await expect(
    page.getByRole("dialog", { name: "Settings" }).getByText("Recognized File Types", { exact: true }),
  ).toBeVisible();
});

test("offers Astro installation, enable controls and custom language selection", async ({
  workbench: page,
}, testInfo) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Language Servers");
  await dialog.getByRole("treeitem", { name: "Language Servers", exact: true }).click();
  await dialog.locator('[data-tool="astro-language-server"]').click();
  const details = dialog.getByLabel("Astro Language Server details");
  await expect(details.getByRole("checkbox", { name: /Use Astro Language Server/ })).toBeChecked();
  await expect(details.getByRole("textbox", { name: "Path:" })).toHaveAttribute("placeholder", "Auto-detect");
  await details.getByRole("button", { name: "Startup" }).click();
  await expect(details.getByRole("textbox", { name: "Arguments" })).toHaveAttribute("placeholder", "--stdio");
  await expect(details.getByRole("button", { name: "Install Astro Language Server" })).toBeVisible();
  const settingsShot = testInfo.outputPath("astro-settings.png");
  await page.screenshot({ path: settingsShot, animations: "disabled" });
  await testInfo.attach("Astro settings (browser preview)", { path: settingsShot, contentType: "image/png" });
  await dialog.getByRole("button", { name: "Add Language Server…" }).click();
  const add = page.getByRole("dialog", { name: "New Language Server" });
  await add.getByRole("button", { name: "Languages" }).click();
  await expect(page.getByRole("checkbox", { name: "Astro", exact: true })).toBeVisible();
});
