import { expect, test } from "./fixtures";

test("Appearance keeps themes and UI font controls grouped across Settings widths", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Use custom font");
  await dialog.getByRole("treeitem", { name: "Appearance", exact: true }).click();
  await search.clear();

  const theme = dialog.getByRole("button", { name: "Theme", exact: true });
  const sync = dialog.getByRole("checkbox", { name: "Sync with OS", exact: true });
  const preferences = dialog.getByRole("button", { name: "Preferred themes", exact: true });
  const more = dialog.getByRole("button", { name: "Get more themes", exact: true });
  const font = dialog.getByRole("combobox", { name: "UI font", exact: true });
  const fallback = dialog.getByRole("combobox", { name: "UI fallback font", exact: true });
  const size = dialog.getByRole("textbox", { name: "UI font size", exact: true });
  const custom = dialog.getByRole("checkbox", { name: "Use custom font:", exact: true });
  await expect(preferences).toBeDisabled();
  await expect(font).toBeDisabled();
  await expect(size).toBeDisabled();
  await expect(fallback).toBeDisabled();

  const [themeBox, gearBox, linkBox, fontBox, sizeBox, fallbackBox] = await Promise.all(
    [theme, preferences, more, font, size, fallback].map((control) => control.boundingBox()),
  );
  if (!themeBox || !gearBox || !linkBox || !fontBox || !sizeBox || !fallbackBox) {
    throw new Error("Missing Appearance control bounds");
  }
  expect(linkBox.y).toBeGreaterThan(themeBox.y + themeBox.height);
  expect(gearBox.x).toBeGreaterThan(themeBox.x + themeBox.width);
  expect(gearBox.y + gearBox.height / 2).toBeCloseTo(themeBox.y + themeBox.height / 2, 0);
  expect(sizeBox.y).toBeCloseTo(fontBox.y, 0);
  expect(sizeBox.x).toBeGreaterThan(fontBox.x + fontBox.width);
  expect(fallbackBox.x).toBeCloseTo(fontBox.x, 0);
  expect(fallbackBox.y).toBeGreaterThan(fontBox.y);

  await sync.check();
  await expect(theme).toBeDisabled();
  for (const width of [580, 520]) {
    await page.setViewportSize({ width, height: 800 });
    await preferences.click();
    const popup = page.getByRole("dialog", { name: "Preferred themes", exact: true });
    const light = popup.getByRole("button", { name: "Preferred light theme", exact: true });
    const dark = popup.getByRole("button", { name: "Preferred dark theme", exact: true });
    await expect(light).toBeInViewport({ ratio: 1 });
    await expect(dark).toBeInViewport({ ratio: 1 });
    const [lightBox, darkBox] = await Promise.all([light.boundingBox(), dark.boundingBox()]);
    if (!lightBox || !darkBox) throw new Error("Missing preferred theme bounds");
    expect(lightBox.x).toBeCloseTo(darkBox.x, 0);
    expect(lightBox.width).toBeCloseTo(darkBox.width, 0);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    for (const field of [font, size, fallback]) await expect(field).toBeInViewport({ ratio: 1 });
    const [narrowFont, narrowSize, narrowFallback] = await Promise.all(
      [font, size, fallback].map((control) => control.boundingBox()),
    );
    if (!narrowFont || !narrowSize || !narrowFallback) throw new Error("Missing narrow font control bounds");
    expect(narrowSize.y).toBeGreaterThan(narrowFont.y);
    expect(narrowFallback.x).toBeCloseTo(narrowFont.x, 0);
  }

  await custom.check();
  await font.fill("Inter");
  await size.fill("15");
  await fallback.fill("Noto Sans CJK SC");
  await fallback.press("Enter");
  await expect(font).toHaveValue("Inter");
  await expect(size).toHaveValue("15");
  await expect(fallback).toHaveValue("Noto Sans CJK SC");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
