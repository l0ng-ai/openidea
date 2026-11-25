import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openConsoleSettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Fold console lines that contain");
  await dialog.getByRole("treeitem", { name: "Console", exact: true }).click();
  await search.clear();
  return dialog;
}

test("Console settings put folding between the basic controls and log colors", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  const dialog = await openConsoleSettings(page);
  const wrap = dialog.getByRole("checkbox", { name: "Use soft wraps in console", exact: true });
  const override = dialog.getByRole("checkbox", { name: /^Override console cycle buffer size/ });
  const size = dialog.getByRole("textbox", { name: "Override console cycle buffer size", exact: true });
  const encoding = dialog.getByRole("button", { name: "Default encoding", exact: true });
  const list = dialog.getByRole("listbox", { name: "Fold console lines that contain", exact: true });
  const colors = dialog.getByRole("checkbox", { name: "Colour log lines by level", exact: true });
  await expect(list).toBeVisible();
  expect((await list.boundingBox())!.width).toBeGreaterThan(480);
  const controls = [wrap, override, encoding, list, colors];
  const positions = await Promise.all(controls.map(async (control) => (await control.boundingBox())!.y));
  positions.forEach((y, index) => {
    if (index > 0) expect(y).toBeGreaterThan(positions[index - 1]!);
  });

  for (const width of [580, 520]) {
    await page.setViewportSize({ width, height: 740 });
    for (const control of [...controls, size]) await expect(control).toBeInViewport({ ratio: 1 });
    expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
});

test("Console settings keep the stored buffer size and fold rules across Apply and reopen", async ({
  workbench: page,
}) => {
  const dialog = await openConsoleSettings(page);
  const override = dialog.getByRole("checkbox", { name: /^Override console cycle buffer size/ });
  const size = dialog.getByRole("textbox", { name: "Override console cycle buffer size", exact: true });
  const list = dialog.getByRole("listbox", { name: "Fold console lines that contain", exact: true });
  await override.check();
  await expect(size).toBeEnabled();
  await size.fill("2048");
  await override.uncheck();
  await expect(size).toBeDisabled();
  await expect(size).toHaveValue("2048");

  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const pattern = list.getByRole("textbox", { name: "Pattern", exact: true });
  await pattern.fill("at example.retry");
  await pattern.press("Enter");
  await expect(list.getByRole("option", { name: "at example.retry", exact: true })).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  await openConsoleSettings(page);
  await expect(override).not.toBeChecked();
  await expect(size).toBeDisabled();
  await expect(size).toHaveValue("2048");
  await expect(list.getByRole("option", { name: "at example.retry", exact: true })).toBeVisible();
  await override.check();
  await expect(size).toBeEnabled();
  await expect(size).toHaveValue("2048");
});
