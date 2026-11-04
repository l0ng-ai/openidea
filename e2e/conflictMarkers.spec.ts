import { expect, openFromTree, test } from "./fixtures";

const MARKERS = ["<<<<<<< Updated upstream", "ours();", "=======", "theirs();", ">>>>>>> Stashed changes"];

test("flags merge conflict markers typed into a file as errors, with no language server", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  // Typed line by line: the editor indents each new line like the one above.
  for (const line of MARKERS) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  // One error on each of the three marker lines.
  await expect(editor.locator(".cm-lintRange-error")).toHaveCount(3);
  // Undoing the marker lines clears them again.
  for (let i = 0; i < 40; i++) await page.keyboard.press("Meta+z");
  await expect(editor.locator(".cm-lintRange-error")).toHaveCount(0);
});
