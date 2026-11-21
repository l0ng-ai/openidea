import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function openAnalyzer(page: Page, clipboard: string) {
  await page.evaluate(async (text) => {
    window.__ipc.handlers.clipboard_text = () => text;
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("analyze.stackTrace");
  }, clipboard);
}

test("the stack trace editor uses editor typography and resizes with its dialog", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const settings = useProject.getState().settings;
    useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, fontSize: 16, lineHeight: 24 } } });
  });
  const trace =
    "java.lang.IllegalStateException: The report still has rows without a settlement reference in the monthly review\n" +
    "\tat com.example.Settlement.reconcile(Report.java:5)\n" +
    "\tat com.example.Settlement.main(Report.java:3)";
  await openAnalyzer(page, trace);
  const dialog = page.getByRole("dialog", { name: "Analyze Stack Trace" });
  const editor = dialog.getByRole("textbox", { name: /Put a stack trace/ });
  const analyze = dialog.getByRole("button", { name: "Analyze", exact: true });
  await expect(editor).toHaveValue(trace);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS("font-size", "16px");
  await expect(editor).toHaveCSS("line-height", "24px");
  await expect(dialog.getByText(/Put a stack trace/)).toHaveCSS("font-size", "13px");
  const size = await editor.evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
    scroll: el.scrollWidth,
  }));
  expect(size.width).toBeGreaterThan(580);
  expect(size.width).toBeLessThan(615);
  expect(size.height).toBeGreaterThan(380);
  expect(size.scroll).toBeGreaterThan(size.width);

  const grip = dialog.getByRole("separator", { name: "Resize" });
  const corner = (await grip.boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 64, corner.y + corner.height / 2 + 48);
  await page.mouse.up();
  await expect.poll(() => editor.evaluate((el) => el.clientWidth)).toBeGreaterThan(size.width + 55);
  await expect.poll(() => editor.evaluate((el) => el.clientHeight)).toBeGreaterThan(size.height + 40);
  await expect(editor).toHaveValue(trace);

  await analyze.click();
  const console = page.getByRole("log", { name: "Stack trace IllegalStateException" });
  await expect(console.getByRole("link", { name: "Report.java:5", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 400, height: 390 });
  await openAnalyzer(page, "Unrelated clipboard text");
  await expect(editor).toHaveValue("");
  await expect(editor).toBeInViewport({ ratio: 1 });
  await expect(analyze).toBeInViewport({ ratio: 1 });
  await expect(analyze).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
