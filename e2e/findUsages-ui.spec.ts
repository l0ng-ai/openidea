import type { Locator } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function checkSize(icon: Locator, size = 16) {
  const dimensions = await icon.evaluate((node) => {
    const style = getComputedStyle(node);
    return [Number.parseFloat(style.width), Number.parseFloat(style.height)];
  });
  expect.soft(dimensions).toEqual([size, size]);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [160, 320]) {
    test(`Find and Usages icons align in ${theme} at ${width}px`, async ({ workbench: page }) => {
      await page.evaluate(async (theme) => {
        const themePath = "/src/workbench/theme.ts";
        const findPath = "/src/features/search/find/windowStore.ts";
        const { previewTheme } = await import(themePath);
        const { openInFindWindow, useFindViewOptions } = await import(findPath);
        previewTheme(theme);
        useFindViewOptions.setState({ groupByDirectory: true });
        let finish: (() => void) | undefined;
        let request = 0;
        openInFindWindow(
          { pattern: "build", caseSensitive: false, wholeWord: false, isRegex: false, context: "any" },
          "build",
          {
            deps: {
              validate: async () => {},
              nextRequestId: () => ++request,
              cancel: () => finish?.(),
              start: async (_id: number, _query: unknown, onFile: (file: object) => void) => {
                onFile({
                  path: "/dev/acme-api/build.gradle.kts",
                  relPath: "build.gradle.kts",
                  matches: [{ line: 0, text: "build", textOffset: 0, ranges: [[0, 5]] }],
                });
                await new Promise<void>((resolve) => (finish = resolve));
                return { files: 1, matches: 1, limitHit: false, cancelled: true, elapsedMs: 1 };
              },
            },
          },
        );
      }, theme);

      const find = page.getByRole("region", { name: "Find", exact: true });
      const tree = find.getByRole("tree", { name: "Find results" });
      await expect(tree.getByText("build.gradle.kts", { exact: true })).toBeVisible();
      const panel = tree.locator("..");
      const bounds = (await panel.boundingBox())!;
      const handle = (await find.getByRole("separator").boundingBox())!;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + width, y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - width)).toBeLessThan(2);

      const fileIcon = tree
        .getByRole("treeitem")
        .filter({ has: page.getByText("build.gradle.kts", { exact: true }) })
        .locator("svg")
        .last();
      const directoryIcon = tree
        .getByRole("treeitem")
        .filter({ has: page.getByText("/", { exact: true }) })
        .locator("svg")
        .last();
      await checkSize(fileIcon);
      await checkSize(directoryIcon);
      await checkSize(find.getByRole("status", { name: "Loading", exact: true }));
      for (const title of ["Stop", "Expand All", "Collapse All", "Close Tab"])
        await checkSize(find.getByRole("button", { name: title, exact: true }).last().locator("svg"));

      await page.evaluate(async () => {
        const path = "/src/ui/iconAppearance.ts";
        (await import(path)).setIconAppearance({ iconSize: 20, rowHeight: 28 });
      });
      await checkSize(fileIcon, 20);
      await checkSize(directoryIcon, 20);
      await checkSize(find.getByRole("status", { name: "Loading", exact: true }));
      await find.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(find.getByRole("status", { name: "Loading", exact: true })).toHaveCount(0);
      await checkSize(find.getByRole("button", { name: "Rerun", exact: true }).locator("svg"));
      await find.getByRole("button", { name: "Rerun", exact: true }).click();
      await expect(find.getByRole("status", { name: "Loading", exact: true })).toBeVisible();
      await find.getByRole("button", { name: "Stop", exact: true }).click();

      await page.evaluate(async () => {
        const path = "/src/features/code-insight/usages.ts";
        const { useUsagesPopup } = await import(path);
        useUsagesPopup.setState({
          open: true,
          anchor: { x: 100, y: 150 },
          symbol: "build",
          loading: true,
          groups: [
            {
              path: "/dev/acme-api/build.gradle.kts",
              usages: [{ path: "/dev/acme-api/build.gradle.kts", line: 0, col: 0, endCol: 5, text: "build" }],
            },
          ],
        });
      });
      const popup = page.getByRole("dialog", { name: "Usages", exact: true });
      await checkSize(popup.getByRole("option").locator("svg"));
      await checkSize(popup.getByRole("status", { name: "Loading", exact: true }));
      const preview = popup.getByRole("button", { name: "Show Preview", exact: true });
      await checkSize(preview.locator("svg"));
      await preview.focus();
      await page.keyboard.press("Enter");
      await expect(popup.getByRole("region", { name: "Preview", exact: true })).toBeVisible();
      await preview.click();
      await expect(popup.getByRole("region", { name: "Preview", exact: true })).toHaveCount(0);
      await popup.getByRole("button", { name: /Open in Find Window/ }).click();

      const usages = page.getByRole("region", { name: "Find Usages", exact: true });
      const usageTree = usages.getByRole("tree", { name: "Usages", exact: true });
      await expect(usageTree.getByText("build.gradle.kts", { exact: true })).toBeVisible();
      const usageIcon = usageTree
        .getByRole("treeitem")
        .filter({ has: page.getByText("build.gradle.kts", { exact: true }) })
        .locator("svg")
        .last();
      await checkSize(usageIcon, 20);
      await page.evaluate(async () => {
        const path = "/src/features/code-insight/usages.ts";
        const { useUsages } = await import(path);
        useUsages.setState((s: { tabs: object[] }) => ({ tabs: s.tabs.map((t) => ({ ...t, loading: true })) }));
      });
      await checkSize(usages.getByRole("status", { name: "Loading", exact: true }));
      await page.evaluate(async () => {
        const path = "/src/ui/iconAppearance.ts";
        (await import(path)).setIconAppearance(null);
      });
      await checkSize(usageIcon);
    });
  }

  test(`Find in Files keeps its loading icon at native size in ${theme}`, async ({ workbench: page }) => {
    await stubDesktop(page);
    await page.evaluate(async (theme) => {
      const path = "/src/workbench/theme.ts";
      (await import(path)).previewTheme(theme);
      window.__ipc.handlers.search_validate = () => null;
      window.__ipc.handlers.search_start = () => null;
    }, theme);
    await page.keyboard.press("Meta+Shift+f");
    const popup = page.getByRole("dialog", { name: "Find in Files", exact: true });
    await popup.getByRole("textbox", { name: "Text to find" }).fill("build");
    const spinner = popup.getByRole("status", { name: "Loading", exact: true });
    await expect(spinner).toBeVisible();
    await checkSize(spinner);
    const center = await spinner.evaluate((node) => {
      const icon = node.getBoundingClientRect();
      const row = node.parentElement!.getBoundingClientRect();
      return Math.abs(icon.y + icon.height / 2 - (row.y + row.height / 2));
    });
    expect(center).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });
}
