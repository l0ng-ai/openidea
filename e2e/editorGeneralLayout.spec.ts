import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openGeneral(page: Page) {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("File patterns");
  await settings.getByRole("treeitem", { name: "General", exact: true }).click();
  await search.clear();
  return settings;
}

test("Editor General fits the soft-wrap pattern field and stacks the scrolling choices", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 850 });
  const settings = await openGeneral(page);
  const softWraps = settings.getByRole("region", { name: "Soft Wraps", exact: true });
  const wrap = softWraps.getByRole("checkbox", { name: "Soft-wrap files", exact: true });
  const patterns = softWraps.getByRole("textbox", { name: "File patterns" });
  const scrolling = settings.getByRole("region", { name: "Scrolling", exact: true });
  const virtualSpace = settings.getByRole("region", { name: "Virtual Space", exact: true });
  const caretPrompt = scrolling.getByText("When caret is moved", { exact: true });
  const center = scrolling.getByRole("radio", { name: /keep caret line centered/ });
  const minimize = scrolling.getByRole("radio", { name: /minimize editor scrolling/ });

  await expect(patterns).toBeVisible();
  const toggle = (await wrap.boundingBox())!;
  const field = (await patterns.boundingBox())!;
  expect(toggle.y).toBeGreaterThan(field.y);
  expect(toggle.y + toggle.height).toBeLessThan(field.y + field.height);
  expect(field.x).toBeGreaterThan(toggle.x + toggle.width);
  expect(await patterns.getAttribute("aria-describedby")).toBeTruthy();

  for (const width of [1120, 520]) {
    await page.setViewportSize({ width, height: 850 });
    await patterns.scrollIntoViewIfNeeded();
    await expect(patterns).toBeInViewport({ ratio: 0.99 });
    const fieldBox = (await patterns.boundingBox())!;
    const indent = softWraps.getByRole("checkbox", { name: "Use original line's indent for wrapped parts" });
    expect((await indent.boundingBox())!.y).toBeGreaterThan(fieldBox.y + fieldBox.height);
    expect(await scrolling.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect((await scrolling.boundingBox())!.y).toBeGreaterThan((await virtualSpace.boundingBox())!.y);
    const first = (await center.boundingBox())!;
    const second = (await minimize.boundingBox())!;
    expect(first.x).toBeGreaterThan((await caretPrompt.boundingBox())!.x);
    expect(second.y).toBeGreaterThan(first.y + first.height);
    expect(Math.abs(first.x - second.x)).toBeLessThan(1);
  }
});

test("Editor General keeps wheel and wrap dependencies and saves the selected values", async ({ workbench: page }) => {
  const settings = await openGeneral(page);
  const zoom = settings.getByRole("checkbox", { name: "Change font size with Ctrl/Command+Mouse Wheel" });
  const active = settings.getByRole("radio", { name: "Active editor", exact: true });
  const all = settings.getByRole("radio", { name: "All editors", exact: true });
  const wrap = settings.getByRole("checkbox", { name: "Soft-wrap files", exact: true });
  const patterns = settings.getByRole("textbox", { name: "File patterns", exact: true });
  const indent = settings.getByRole("checkbox", { name: "Use original line's indent for wrapped parts" });
  const apply = settings.getByRole("button", { name: "Apply", exact: true });
  const cancel = settings.getByRole("button", { name: "Cancel", exact: true });

  await zoom.uncheck();
  await expect(active).toBeDisabled();
  await expect(all).toBeDisabled();
  await zoom.check();
  await expect(active).toBeChecked();
  await active.focus();
  await page.keyboard.press("ArrowDown");
  await expect(all).toBeChecked();
  await wrap.uncheck();
  await expect(patterns).toBeDisabled();
  await expect(indent).toBeDisabled();
  await wrap.check();
  await expect(indent).toBeEnabled();
  await patterns.fill("*.md; *.notes");
  await apply.click();
  await expect(apply).toBeDisabled();
  await cancel.click();

  await openGeneral(page);
  await expect(zoom).toBeChecked();
  await expect(all).toBeChecked();
  await expect(wrap).toBeChecked();
  await expect(patterns).toHaveValue("*.md; *.notes");
});
