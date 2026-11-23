import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openEditorTabsSettings(page: Page) {
  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("file.settings", "editor.general.editorTabs");
  });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("region", { name: "Closing Policy", exact: true })).toBeVisible();
  return dialog;
}

test("Editor Tabs aligns appearance fields and stacks closing choices at both widths", async ({ workbench: page }) => {
  const settings = await openEditorTabsSettings(page);
  const appearance = settings.getByRole("region", { name: "Appearance", exact: true });
  const placement = appearance.getByRole("button", { name: "Tab placement", exact: true });
  const closePosition = appearance.getByRole("button", { name: "Close button position", exact: true });
  const closing = settings.getByRole("region", { name: "Closing Policy", exact: true });
  const limit = closing.getByRole("textbox", { name: "Tab limit", exact: true });
  const footer = settings.getByRole("button", { name: "OK", exact: true });

  for (const width of [1100, 580]) {
    await page.setViewportSize({ width, height: 760 });
    const placementBox = (await placement.boundingBox())!;
    const closeBox = (await closePosition.boundingBox())!;
    expect(Math.abs(placementBox.x - closeBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(placementBox.width - closeBox.width)).toBeLessThanOrEqual(1);
    await expect(placement).toBeInViewport();
    await expect(limit).toHaveValue("30");

    for (const name of ["When the tab limit is reached", "When the current tab is closed, activate"]) {
      const choices = closing.getByRole("radiogroup", { name, exact: true }).getByRole("radio");
      const first = (await choices.first().boundingBox())!;
      const last = (await choices.last().boundingBox())!;
      expect(Math.abs(first.x - last.x)).toBeLessThanOrEqual(1);
      expect(last.y).toBeGreaterThan(first.y + first.height);
      expect(last.x + last.width).toBeLessThanOrEqual(width);
    }
    await expect(footer).toBeInViewport();
  }
});

test("Editor Tabs keeps row and overflow choices independently selected and keyboard operable", async ({
  workbench: page,
}) => {
  const settings = await openEditorTabsSettings(page);
  const group = settings.getByRole("radiogroup", { name: "Show tabs in", exact: true });
  const one = group.getByRole("radio", { name: /^One row/ });
  const multiple = group.getByRole("radio", { name: "Multiple rows", exact: true });
  const scroll = group.getByRole("radio", { name: "Scroll the tabs panel", exact: true });
  const squeeze = group.getByRole("radio", { name: "Squeeze tabs", exact: true });
  await expect(one).toBeChecked();
  await expect(scroll).toBeChecked();
  const oneBox = (await one.boundingBox())!;
  const scrollBox = (await scroll.boundingBox())!;
  const multipleBox = (await multiple.boundingBox())!;
  expect(scrollBox.x).toBeGreaterThan(oneBox.x + 8);
  expect(scrollBox.y).toBeGreaterThan(oneBox.y);
  expect(Math.abs(multipleBox.x - oneBox.x)).toBeLessThanOrEqual(1);
  expect(multipleBox.y).toBeGreaterThan(scrollBox.y);

  await scroll.press("ArrowDown");
  await expect(squeeze).toBeFocused();
  await expect(squeeze).toBeChecked();
  await expect(one).toBeChecked();
  await one.press("ArrowDown");
  await expect(multiple).toBeFocused();
  await expect(multiple).toBeChecked();
  await expect(squeeze).toBeDisabled();
  await expect(squeeze).toBeChecked();
  await multiple.press("ArrowUp");
  await expect(one).toBeChecked();
  await expect(squeeze).toBeEnabled();
  await settings.getByRole("button", { name: "OK", exact: true }).click();

  const reopened = await openEditorTabsSettings(page);
  await expect(reopened.getByRole("radio", { name: /^One row/ })).toBeChecked();
  await expect(reopened.getByRole("radio", { name: "Squeeze tabs", exact: true })).toBeChecked();
});
