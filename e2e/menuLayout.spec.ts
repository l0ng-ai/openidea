import { expect, openFromTree, test } from "./fixtures";

test("keyboard navigation reveals items in a short Git submenu", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 650, height: 390 });
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Git", exact: true }).hover();
  const last = page.getByRole("menuitem", { name: "Get from Version Control…", exact: true });
  const popup = last.locator("xpath=ancestor::*[@data-popup][1]");
  const first = popup.locator('[role="menuitem"]:not([aria-disabled="true"])').first();
  await expect(popup).toHaveAttribute("data-positioned", "true");
  await expect(first).toBeFocused();
  expect(await popup.evaluate((el) => el.scrollHeight)).toBeGreaterThan(await popup.evaluate((el) => el.clientHeight));

  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  const scroll = await popup.evaluate((el) => el.scrollTop);
  await popup.evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press("End");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBe(scroll);

  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport({ ratio: 1 });
  await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBeLessThan(scroll);
  await page.keyboard.press("ArrowLeft");
  await expect(last).toBeHidden();
  await expect(page.getByRole("menuitem", { name: "Git", exact: true })).toBeFocused();
});

test("shortcut ends align on a menu level with submenus", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const chord = "Ctrl+Shift+Meta+K, Ctrl+Shift+Meta+B, Ctrl+Shift+Meta+M";
  await page.evaluate(async (chord) => {
    const path = "/src/ui/Menu.tsx";
    const { showContextMenu } = await import(/* @vite-ignore */ path);
    showContextMenu({ x: 80, y: 80 }, [
      { label: "Open", shortcut: "Ctrl+O" },
      { label: "Open Recent", shortcut: "Ctrl+Shift+O", submenu: [{ label: "Payments service" }] },
      { label: "Open File in a New Window", shortcut: chord },
    ]);
  }, chord);
  const menu = page.getByRole("menu", { name: "Context menu" });
  const first = menu.getByText("Ctrl+O", { exact: true });
  const second = menu.getByText("Ctrl+Shift+O", { exact: true });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const a = (await first.boundingBox())!;
  const b = (await second.boundingBox())!;
  expect(a.x + a.width).toBeCloseTo(b.x + b.width, 0);
  const long = menu.getByText(chord, { exact: true });
  await expect(long).toHaveAttribute("title", chord);
  expect(await long.evaluate((el) => el.scrollWidth)).toBeGreaterThan(await long.evaluate((el) => el.clientWidth));
  await expect(menu.getByText("Open File in a New Window", { exact: true })).toBeInViewport({ ratio: 1 });
});

test("a context menu moves up to fit, and one taller than the window scrolls without cutting labels", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const open = (y: number, count: number) =>
    page.evaluate(
      async ({ y, count }) => {
        const path = "/src/ui/Menu.tsx";
        const { showContextMenu } = await import(/* @vite-ignore */ path);
        showContextMenu(
          { x: 80, y },
          Array.from({ length: count }, (_, i) => ({ label: `Convert to Jupyter Notebook ${i}`, shortcut: "Ctrl+O" })),
        );
      },
      { y, count },
    );
  const menu = page.getByRole("menu", { name: "Context menu" });
  const popup = menu.locator("xpath=ancestor::*[@data-popup][1]");
  const cut = () =>
    menu.evaluate((el) =>
      [...el.querySelectorAll('[role="menuitem"] > span')].some((s) => s.scrollWidth > s.clientWidth),
    );

  // Taller than the space below and above the point, not than the window: moved up rather than scrolled.
  await open(240, 12);
  await expect(popup).toHaveAttribute("data-positioned", "true");
  expect(await popup.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
  await expect(menu.getByRole("menuitem").last()).toBeInViewport({ ratio: 1 });
  expect(await cut()).toBe(false);
  await page.keyboard.press("Escape");

  // Taller than the window: scrolls, and the scrollbar widens the menu instead of cutting its labels.
  await open(240, 40);
  await expect(popup).toHaveAttribute("data-positioned", "true");
  expect(await popup.evaluate((el) => el.scrollHeight)).toBeGreaterThan(await popup.evaluate((el) => el.clientHeight));
  expect(await cut()).toBe(false);
});
