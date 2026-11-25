import { expect, test } from "./fixtures";

test("the editor color picker fits recent colors and keeps its actions visible", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await page.evaluate(async () => {
    const recent = Array.from({ length: 20 }, (_, i) => `#${((i + 1) * 314241).toString(16).padStart(6, "0")}ff`);
    localStorage.setItem("openidea.colorPicker.recent.v1", JSON.stringify(recent));
    const contributions = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ contributions);
    await editorService().openFile("/dev/acme-api/theme.css");
  });
  const editor = page.locator(".cm-editor").first();
  const contents = editor.locator(".cm-content");
  await contents.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(".notice { color: #5a8fbd; }");

  const swatch = editor.locator(".cm-openidea-gutter-colors").getByTitle("#5a8fbd", { exact: true });
  const picker = page.getByRole("dialog", { name: "Color picker", exact: true });
  const palette = picker.locator(".react-colorful__saturation");
  const hex = picker.getByRole("textbox", { name: "Hexadecimal", exact: true });
  const apply = picker.getByRole("button", { name: "Apply", exact: true });
  const cancel = picker.getByRole("button", { name: "Cancel", exact: true });
  const recent = picker.getByRole("group", { name: "Recent colors", exact: true }).getByRole("button");
  await swatch.click();
  await expect(hex).toHaveValue("5A8FBDFF");
  expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(308);
  await expect(palette).toHaveCSS("height", "152px");
  expect(await picker.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await hex.fill("#ff0000");
  expect(await picker.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await page.setViewportSize({ width: 280, height: 315 });
  await swatch.click();
  await expect(recent).toHaveCount(20);
  const swatchRows = await recent.evaluateAll((elements) => {
    const rows: number[] = [];
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (!rows.includes(box.top)) rows.push(box.top);
      const previous = element.previousElementSibling?.getBoundingClientRect();
      if (previous?.top === box.top && previous.right > box.left) throw new Error("Color swatches overlap");
    }
    return rows.length;
  });
  expect(swatchRows).toBeGreaterThan(2);
  expect(await picker.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await expect(apply).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await hex.fill("#d27c54");
  await cancel.click();
  await expect(picker).toBeHidden();
  await expect(contents).toContainText("#5a8fbd");

  await swatch.click();
  await hex.fill("#d27c54");
  await apply.click();
  await expect(picker).toBeHidden();
  await expect(contents).toContainText("#d27c54");
});
