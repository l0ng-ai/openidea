import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Debugger Data Views keeps the hover delay with its setting at each window width", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.settings_get_global = () => ({});
  });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("value tooltip delay");
  await settings.getByRole("treeitem", { name: "Data Views", exact: true }).click();
  await search.clear();

  const hover = settings.getByRole("checkbox", { name: "Show value tooltip on mouse hover", exact: true });
  const delay = settings.getByRole("textbox", { name: "Value tooltip delay (ms)", exact: true });
  const selection = settings.getByRole("checkbox", { name: "Show value tooltip on code selection", exact: true });
  const sort = settings.getByRole("checkbox", { name: "Sort values alphabetically", exact: true });
  const editor = settings.getByRole("region", { name: "Editor", exact: true });

  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(delay).toBeInViewport({ ratio: 1 });
    const [toggleBox, delayBox, selectionBox] = await Promise.all(
      [hover, delay, selection].map((control) => control.boundingBox()),
    );
    if (!toggleBox || !delayBox || !selectionBox) throw new Error("Missing Data Views control bounds");
    expect(delayBox.y + delayBox.height).toBeLessThan(selectionBox.y);
    if (width === 1120) {
      expect(delayBox.x).toBeGreaterThan(toggleBox.x + toggleBox.width);
      expect(Math.abs(delayBox.y + delayBox.height / 2 - toggleBox.y - toggleBox.height / 2)).toBeLessThan(3);
    } else {
      expect(delayBox.y).toBeGreaterThan(toggleBox.y + toggleBox.height);
    }
  }
  await expect(editor.getByRole("checkbox", { name: "Show values inline", exact: true })).toBeVisible();
  await expect(editor.getByRole("checkbox", { name: "Sort values alphabetically", exact: true })).toHaveCount(0);
  await expect(sort).toBeVisible();

  await expect(hover).toBeChecked();
  await expect(delay).toHaveValue("700");
  await delay.fill("900");
  await selection.uncheck();
  await hover.uncheck();
  await expect(delay).toBeDisabled();
  await expect(delay).toHaveValue("900");
  await selection.check();
  await expect(hover).not.toBeChecked();
  await hover.check();
  await expect(delay).toBeEnabled();
  await expect(delay).toHaveValue("900");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
});
