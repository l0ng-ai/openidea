import { expect, test } from "./fixtures";

test("Date Formats keeps its preview beside the formatting controls and updates it while editing", async ({
  workbench: page,
}) => {
  await page.clock.setFixedTime(new Date(2026, 0, 16, 14, 35));
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  const openPage = async () => {
    await search.fill("Date Formats");
    await dialog.getByRole("treeitem", { name: "Date Formats", exact: true }).click();
    await search.clear();
  };
  await openPage();

  const override = dialog.getByRole("checkbox", { name: "Override system date and time format" });
  const pattern = dialog.getByRole("textbox", { name: /^Date format/ });
  const hour = dialog.getByRole("checkbox", { name: "Use 24-hour time format" });
  const pretty = dialog.getByRole("checkbox", { name: "Use pretty formatting" });
  const hint = dialog.getByText("Placeholders: yyyy, yy, MMMM, MMM, MM, M, dd, d", { exact: true });
  const initialPreview = dialog.getByText(/Today .* · /);

  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 680 });
    await expect(async () => {
      const [hourBox, previewBox, prettyBox, patternBox, hintBox] = await Promise.all(
        [hour, initialPreview, pretty, pattern, hint].map((control) => control.boundingBox()),
      );
      expect(previewBox!.y).toBeGreaterThan(hourBox!.y + hourBox!.height);
      expect(prettyBox!.y).toBeGreaterThan(previewBox!.y + previewBox!.height);
      if (width === 1120) {
        expect(hintBox!.x).toBeGreaterThan(patternBox!.x + patternBox!.width);
        expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(patternBox!.y + patternBox!.height + 1);
      } else {
        expect(hintBox!.y).toBeGreaterThanOrEqual(patternBox!.y + patternBox!.height);
      }
    }).toPass({ timeout: 3000 });
  }

  const preview = dialog.getByRole("status", { name: /^Preview/ });
  await expect(pattern).toBeDisabled();
  await expect(hour).toBeDisabled();
  await expect(pretty).toBeEnabled();
  await override.check();
  await pattern.fill("yyyy-MM-dd");
  await expect(preview).toHaveText("Today 12:35 · 2026-01-13 14:35");
  await hour.uncheck();
  await expect(preview).toHaveText("Today 12:35 PM · 2026-01-13 2:35 PM");
  await pretty.uncheck();
  await expect(preview).toHaveText("2026-01-16 12:35 PM · 2026-01-13 2:35 PM");

  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await openPage();
  await expect(override).toBeChecked();
  await expect(pattern).toHaveValue("yyyy-MM-dd");
  await expect(hour).not.toBeChecked();
  await expect(pretty).not.toBeChecked();
  await expect(preview).toHaveText("2026-01-16 12:35 PM · 2026-01-13 2:35 PM");
});
