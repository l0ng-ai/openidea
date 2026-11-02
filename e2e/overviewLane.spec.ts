import { expect, openFromTree, test } from "./fixtures";

// Headless Chromium hides scrollbars by default; this test drags one.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("the scrollbar thumb drags even where overview marks cover it (#752)", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(Array.from({ length: 400 }, (_, i) => `val mark${i} = ${i}`).join("\n"));
  // A match on every line covers the overview lane, as a new file's change mark does.
  await page.keyboard.press("Meta+f");
  await page.getByRole("textbox", { name: "Find" }).fill("mark");
  await expect(editor.locator(".cm-openidea-overviewMark").first()).toBeVisible();
  const scroller = editor.locator(".cm-scroller");
  await scroller.evaluate((s) => (s.scrollTop = 0));
  const box = (await scroller.boundingBox())!;
  // Over a mark and inside the thumb, which is at the top of the track.
  const x = box.x + box.width - 5;
  const y = box.y + 12;
  await page.mouse.move(x - 40, y);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 150, { steps: 10 });
  await page.mouse.up();
  expect(await scroller.evaluate((s) => s.scrollTop)).toBeGreaterThan(0);
  // Away from the thumb the marks take the pointer again.
  await page.mouse.move(x, box.y + box.height - 20);
  await expect(editor.locator(".cm-openidea-overview")).not.toHaveClass(/cm-openidea-overview-onThumb/);
});
