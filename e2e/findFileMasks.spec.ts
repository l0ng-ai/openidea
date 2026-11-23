import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function stubProjectTypes(page: Page, types: string[]) {
  await stubDesktop(page);
  await page.evaluate((types) => {
    const h = window.__ipc.handlers;
    h.index_file_extensions = () => types.map((extension, i) => ({ extension, files: 100 - i }));
    h.languages = () => types.map((extension) => ({ id: extension, name: extension, extensions: [extension] }));
    h.search_validate = () => null;
  }, types);
}

async function openMaskMenu(page: Page) {
  await page.keyboard.press("Meta+Shift+f");
  const dialog = page.getByRole("dialog", { name: "Find in Files" });
  await dialog.getByRole("button", { name: "Recent file masks" }).click();
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  return menu;
}

test("the file mask menu offers every known file type in the project", async ({ workbench: page }) => {
  await stubProjectTypes(page, ["rs", "md", "json", "toml", "yml", "properties"]);
  const menu = await openMaskMenu(page);
  await expect(menu.getByRole("menuitem")).toHaveText(["*.rs", "*.md", "*.json", "*.toml", "*.yml", "*.properties"]);
  await menu.getByRole("menuitem", { name: "*.properties" }).click();
  await expect(page.getByRole("textbox", { name: "File mask" })).toHaveValue("*.properties");
});

test("a long file mask menu stays inside the window and scrolls to its last type", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 520 });
  const types = Array.from({ length: 40 }, (_, i) => `type${String(i).padStart(2, "0")}`);
  await stubProjectTypes(page, types);
  const menu = await openMaskMenu(page);
  const popup = menu.locator("..");
  await expect(menu.getByRole("menuitem")).toHaveCount(40);
  await expect
    .poll(async () => {
      const { y, height } = (await popup.boundingBox())!;
      return y >= 0 && y + height <= 520;
    })
    .toBe(true);

  await menu.getByRole("menuitem").first().focus();
  await page.keyboard.press("End");
  const last = menu.getByRole("menuitem", { name: "*.type39" });
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await expect.poll(async () => popup.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});
