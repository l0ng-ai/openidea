import { expect, openFromTree, test } from "./fixtures";

test("Quick Switch Scheme stays centered and opens its numbered choices without leaving the editor", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const content = editor.locator(".cm-content");
  await content.focus();
  const root = page.locator("html");
  const theme = await root.getAttribute("data-theme");
  const colorTheme = await root.getAttribute("data-color-theme");
  await page.keyboard.press("Control+Backquote");
  const menu = page.getByRole("menu", { name: /^(Switch Scheme|Context menu)$/ });
  await expect(menu).toBeVisible();
  for (const { width, height } of [
    { width: 1120, height: 680 },
    { width: 620, height: 540 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(async () => {
      const bounds = await menu.locator("xpath=..").boundingBox();
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(1);
      expect(Math.abs(bounds!.y + bounds!.height / 2 - height / 2)).toBeLessThan(1);
    }).toPass({ timeout: 3000 });
  }
  await expect(menu.getByText("Switch Scheme", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Editor Color Scheme" })).toBeFocused();
  await expect(menu.locator("[data-menu-number]")).toHaveText(["1", "2", "3", "4"]);
  await page.keyboard.press("4");
  const light = page.getByRole("menuitemcheckbox", { name: "Solarized Light" });
  await light.hover();
  await expect(root).toHaveAttribute("data-color-theme", "solarized-light");
  await page.keyboard.press("Escape");
  await expect(light).toBeHidden();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(content).toBeFocused();
  await expect.poll(() => root.getAttribute("data-theme")).toBe(theme);
  await expect.poll(() => root.getAttribute("data-color-theme")).toBe(colorTheme);
});
