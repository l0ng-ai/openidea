import { expect, test } from "./fixtures";

test("stripe tooltips stay inside the viewport with a gap on either side and at corners", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 520, height: 760 });
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "tooltip-anchor";
    button.dataset.tooltipVerbatim = "";
    button.dataset.tooltipShortcut = "⌘1";
    button.style.cssText = "position:fixed;width:40px;height:40px;z-index:2000";
    document.body.append(button);
  });
  const button = page.locator("#tooltip-anchor");
  const tooltip = page.getByRole("tooltip");
  for (const side of ["left", "right"]) {
    for (const top of [0, 360, 720]) {
      for (const long of [false, true]) {
        await page.mouse.move(260, 200);
        await button.evaluate(
          (button, { side, top, long }) => {
            button.dataset.tooltipStripe = side;
            button.dataset.tooltip = long ? "A long tool window title ".repeat(12) : "Project";
            button.style.left = side === "left" ? "0" : "480px";
            button.style.top = `${top}px`;
          },
          { side, top, long },
        );
        await button.hover();
        await expect(tooltip).toHaveAttribute("data-placed", "true");
        const a = (await button.boundingBox())!;
        const t = (await tooltip.boundingBox())!;
        expect(t.x).toBeGreaterThanOrEqual(6);
        expect(t.y).toBeGreaterThanOrEqual(6);
        expect(t.x + t.width).toBeLessThanOrEqual(514);
        expect(t.y + t.height).toBeLessThanOrEqual(754);
        expect(
          t.x >= a.x + a.width + 5 ||
            t.x + t.width <= a.x - 5 ||
            t.y >= a.y + a.height + 5 ||
            t.y + t.height <= a.y - 5,
        ).toBe(true);
        if (!long) expect(side === "left" ? t.x > a.x : t.x < a.x).toBe(true);
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
      }
    }
  }
});

test("stripe themes inherit base tooltip tokens and keep shortcut text readable", async ({ workbench: page }) => {
  const button = page.locator('[data-tooltip-stripe="left"][data-tooltip-shortcut]').first();
  for (const theme of ["dark", "light", "dark-hc", "solarized-light", "solarized-dark", "one-light", "one-dark"]) {
    await page.mouse.move(700, 400);
    await page.evaluate((theme) => {
      const root = document.documentElement;
      root.dataset.theme = theme.endsWith("light") ? "light" : theme === "dark-hc" ? "dark-hc" : "dark";
      if (theme.includes("-light") || ["solarized-dark", "one-dark"].includes(theme)) root.dataset.colorTheme = theme;
      else delete root.dataset.colorTheme;
    }, theme);
    await button.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveAttribute("data-placed", "true");
    const ratio = await tooltip.evaluate((tooltip) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const background = getComputedStyle(tooltip).backgroundColor;
      const foreground = getComputedStyle(tooltip.children[1]!).color;
      const luminance = () => {
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
      const bg = luminance();
      ctx.fillStyle = foreground;
      ctx.fillRect(0, 0, 1, 1);
      const fg = luminance();
      return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    });
    if (["dark", "light", "dark-hc"].includes(theme)) expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
    if (theme !== "light") {
      const aliases = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ["bg", "fg", "border", "shadow"].every(
          (role) => style.getPropertyValue(`--${role}-stripe-tooltip`) === style.getPropertyValue(`--${role}-tooltip`),
        );
      });
      expect(aliases, theme).toBe(true);
    }
    await page.keyboard.press("Escape");
  }
  for (const kind of ["light", "dark"]) {
    await page.mouse.move(700, 400);
    await page.evaluate(async (kind) => {
      const root = document.documentElement;
      delete root.dataset.colorTheme;
      root.dataset.theme = kind;
      root.dataset.pluginTheme = "test/base-tooltip";
      const path = "/src/features/plugins/bridge.ts";
      const { pluginThemeCss } = await import(/* @vite-ignore */ path);
      const style = document.createElement("style");
      style.id = "test-plugin-theme";
      style.textContent = pluginThemeCss({
        kind,
        tokens: {
          "--bg-tooltip": "#183452",
          "--fg-tooltip": "#ffffff",
          "--border-tooltip": "#abcdef",
          "--shadow-tooltip": "0 2px 8px #00000040",
        },
      });
      document.body.append(style);
    }, kind);
    await button.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveCSS("background-color", "rgb(24, 52, 82)");
    await expect(tooltip).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(tooltip).toHaveCSS("border-top-color", "rgb(171, 205, 239)");
    await page.evaluate(() => document.querySelector("#test-plugin-theme")!.remove());
    await page.keyboard.press("Escape");
  }
});
