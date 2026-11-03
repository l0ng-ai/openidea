import { expect, test } from "./fixtures";

const themes = [
  { theme: "light", scheme: "theme" },
  { theme: "dark", scheme: "theme" },
  { theme: "dark-hc", scheme: "theme" },
  { theme: "light", scheme: "dark" },
  { theme: "dark", scheme: "light" },
] as const;

for (const { theme, scheme } of themes) {
  test(`usage highlights have readable text with ${theme} theme and ${scheme} scheme`, async ({
    workbench: page,
  }, info) => {
    await page.evaluate(
      async ({ theme, scheme }) => {
        const themePath = "/src/workbench/theme.ts";
        const schemePath = "/src/platform/colorScheme.ts";
        const usagesPath = "/src/features/code-insight/usages.ts";
        const { applyThemeAttributes } = await import(themePath);
        const { schemeCss } = await import(schemePath);
        const { useUsagesPopup } = await import(usagesPath);
        applyThemeAttributes(theme);
        const style = document.createElement("style");
        style.textContent = schemeCss(scheme);
        document.head.append(style);
        const symbol = "trainingSessionFetch";
        const texts = [
          `export function ${symbol}() {}`,
          `import { ${symbol} } from './api';`,
          `// Call ${symbol} here`,
          `const name = '${symbol}';`,
        ];
        useUsagesPopup.setState({
          open: true,
          anchor: { x: 100, y: 100 },
          symbol,
          groups: texts.map((text, index) => ({
            path: `/contrast/example-${index}.ts`,
            usages: [
              {
                path: `/contrast/example-${index}.ts`,
                line: 0,
                col: text.indexOf(symbol),
                endCol: text.indexOf(symbol) + symbol.length,
                text,
              },
            ],
          })),
          note: null,
        });
      },
      { theme, scheme },
    );
    const popup = page.getByRole("dialog", { name: "Usages", exact: true });
    await expect(popup.locator(".tok-comment").first()).toBeVisible();
    await expect(popup.locator("mark")).toHaveCount(4);
    const ratios = await popup.locator("mark").evaluateAll((marks) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      return marks.flatMap((mark) => {
        const background = luminance(getComputedStyle(mark).backgroundColor);
        return [mark, ...mark.querySelectorAll("*")].map((node) => {
          const foreground = luminance(getComputedStyle(node).color);
          return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
        });
      });
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await popup.screenshot({ path: info.outputPath("usage-highlights.png") });
  });
}
