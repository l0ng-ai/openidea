import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

const latest = "regional-order-reconciliation-endpoints-for-sandbox-environments/".repeat(3) + "checkout\nText to find";

async function seedHistory(page: Page, kind: "find" | "replace") {
  await page.evaluate(
    async ({ kind, latest }) => {
      const searchModule = "/src/platform/search.ts";
      const { rememberSearch } = await import(/* @vite-ignore */ searchModule);
      for (let i = 0; i < 19; i++) rememberSearch(kind, `Order rule ${i}`);
      rememberSearch(kind, latest);
    },
    { kind, latest },
  );
}

async function openHistory(field: Locator, menu: Locator) {
  await field.focus();
  await field.press("Alt+ArrowDown");
  await expect(menu).toBeVisible();
}

test("editor find history grows with the field and restores the original query", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 700 });
  await openFromTree(page, "build.gradle.kts");
  await page.keyboard.press("Meta+f");
  await seedHistory(page, "find");

  const field = page.getByRole("textbox", { name: "Find", exact: true });
  const menu = page.getByRole("menu", { name: "Recent Searches", exact: true });
  await openHistory(field, menu);

  const newest = menu.getByRole("menuitem").first();
  await expect(newest).toHaveText(latest.replace("\n", " ⏎ "));
  await expect(newest).toHaveAttribute("title", latest);
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(420);
  await newest.press("Enter");
  await expect(menu).toBeHidden();
  await expect(field).toHaveValue(latest);
  await expect(field).toBeFocused();
});

test("project replacement history stays inside a narrow window and keeps its heading visible", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 440, height: 520 });
  await page.keyboard.press("Meta+Shift+r");
  await seedHistory(page, "replace");

  const field = page.getByRole("textbox", { name: "Replace with" });
  const menu = page.getByRole("menu", { name: "Recent Replacements" });
  await openHistory(field, menu);

  const popup = menu.locator("..");
  const heading = popup.getByText("Recent Replacements", { exact: true });
  const newest = menu.getByRole("menuitem").first();
  await expect(newest).toHaveText(latest.replace("\n", " ⏎ "));
  await expect
    .poll(async () => {
      const { x, width } = (await popup.boundingBox())!;
      return x >= 0 && x + width <= 440;
    })
    .toBe(true);

  await newest.press("End");
  const oldest = menu.getByRole("menuitem").last();
  await expect(oldest).toBeFocused();
  await expect.poll(async () => popup.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(heading).toBeInViewport();

  await oldest.press("Home");
  await expect(newest).toBeFocused();
  await newest.press("Enter");
  await expect(menu).toBeHidden();
  await expect(field).toHaveValue(latest);
  await expect(field).toBeFocused();
});
