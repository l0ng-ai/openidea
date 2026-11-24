import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openPostfixSettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Postfix Completion");
  await settings.getByRole("treeitem", { name: "Postfix Completion", exact: true }).click();
  await search.clear();
  return settings;
}

test("Postfix Completion pairs the template list with a responsive code preview", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  const settings = await openPostfixSettings(page);
  const list = settings.getByRole("list", { name: "Postfix templates", exact: true });
  const preview = settings.getByRole("region", { name: "Template preview", exact: true });
  const before = preview.locator("pre").first();
  const after = preview.locator("pre").last();
  await expect(before).toHaveText("expr.if");
  await expect(after).toContainText("if (expr)");
  const listBounds = (await list.boundingBox())!;
  const widePreview = (await preview.boundingBox())!;
  expect(widePreview.x).toBeGreaterThanOrEqual(listBounds.x + listBounds.width);
  expect(widePreview.y).toBeLessThan(listBounds.y);

  await list.getByRole("button", { name: ".if", exact: true }).press("ArrowDown");
  const elseTemplate = list.getByRole("button", { name: ".else", exact: true });
  await expect(elseTemplate).toBeFocused();
  await expect(elseTemplate).toHaveAttribute("aria-pressed", "true");
  await expect(before).toHaveText("expr.else");
  await expect(after).toContainText("if (!expr)");

  await page.setViewportSize({ width: 520, height: 760 });
  await settings.getByRole("tab", { name: "Python", exact: true }).click();
  await expect(before).toHaveText("expr.if");
  await expect(after).toContainText("if expr:");
  await after.scrollIntoViewIfNeeded();
  await expect(after).toBeInViewport({ ratio: 0.99 });
  const narrowList = (await list.boundingBox())!;
  const narrowPreview = (await preview.boundingBox())!;
  expect(narrowPreview.y).toBeGreaterThanOrEqual(narrowList.y + narrowList.height);
  expect(Math.abs(narrowList.x - narrowPreview.x)).toBeLessThan(2);
  expect(await preview.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await settings.getByRole("tab", { name: "JavaScript / TypeScript", exact: true }).click();
  await expect(elseTemplate).toHaveAttribute("aria-pressed", "true");
  await expect(before).toHaveText("expr.else");

  await settings.getByRole("tab", { name: "Java", exact: true }).click();
  await list.getByRole("button", { name: ".var", exact: true }).click();
  await expect(preview.getByText("Fallback expansion", { exact: true })).toBeVisible();
  await expect(after).toContainText("var value = expr;");
});

test("Postfix Completion keeps template selection separate from enabled preferences", async ({ workbench: page }) => {
  const settings = await openPostfixSettings(page);
  const master = settings.getByRole("checkbox", { name: "Enable postfix completion", exact: true });
  const expand = settings.getByRole("checkbox", { name: "Expand templates with Tab", exact: true });
  const ifEnabled = settings.getByRole("checkbox", { name: "Enable .if", exact: true });
  const preview = settings.getByRole("region", { name: "Template preview", exact: true });
  const before = preview.locator("pre").first();
  await settings.getByRole("button", { name: ".else", exact: true }).click();
  await expect(ifEnabled).toBeChecked();
  await ifEnabled.uncheck();
  await expect(before).toHaveText("expr.if");
  await master.uncheck();
  await expect(expand).toBeDisabled();
  await expect(ifEnabled).toBeDisabled();
  await settings.getByRole("button", { name: ".else", exact: true }).click();
  await expect(before).toHaveText("expr.else");
  await master.check();
  await expect(ifEnabled).not.toBeChecked();

  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await openPostfixSettings(page);
  await expect(ifEnabled).not.toBeChecked();
  await expect(master).toBeChecked();
});
