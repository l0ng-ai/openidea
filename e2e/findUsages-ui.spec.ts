import type { Locator } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

test("Find Usages places read and write filters with the other actions", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const modulePath = "/src/features/code-insight/usages.ts";
    const { useUsagesPopup } = await import(modulePath);
    const path = "/dev/acme-api/src/SettlementService.ts";
    const lines = ["const current = settlement;", "settlement = next;"];
    window.__ipc.handlers.fs_read_text = () => lines.join("\n");
    useUsagesPopup.setState({
      open: true,
      anchor: { x: 100, y: 150 },
      symbol: "settlement",
      loading: false,
      scope: "project",
      groups: [
        {
          path,
          usages: lines.map((text, line) => ({
            path,
            line,
            col: text.indexOf("settlement"),
            endCol: text.indexOf("settlement") + "settlement".length,
            text,
            access: line === 0 ? "read" : "write",
          })),
        },
      ],
    });
  });

  const popup = page.getByRole("dialog", { name: "Usages", exact: true });
  const read = { name: "Show read accesses", exact: true };
  const write = { name: "Show write accesses", exact: true };
  const actions = popup.getByRole("button", { name: "Show Preview", exact: true }).locator("..");
  await expect(popup.getByRole("option")).toHaveCount(2);
  for (const width of [1120, 540]) {
    await page.setViewportSize({ width, height: 640 });
    expect(await actions.getByRole("toolbar", { name: "Usage access filters", exact: true }).count()).toBe(1);
    await expect(actions.getByRole("button", read)).toBeInViewport({ ratio: 1 });
    await expect(actions.getByRole("button", write)).toBeInViewport({ ratio: 1 });
  }
  await actions.getByRole("button", write).click();
  await expect(popup.getByRole("option")).toHaveCount(1);
  await popup.getByRole("button", { name: /Open in Find Window/ }).click();

  const view = page.getByRole("region", { name: "Find Usages", exact: true });
  const toolbar = view.getByRole("toolbar", { name: "Usages actions", exact: true });
  const readButton = toolbar.getByRole("button", read);
  const writeButton = toolbar.getByRole("button", write);
  await expect(readButton).toHaveAttribute("aria-pressed", "true");
  await expect(writeButton).toHaveAttribute("aria-pressed", "false");
  const a = (await readButton.boundingBox())!;
  const b = (await writeButton.boundingBox())!;
  expect(a.x).toBeCloseTo(b.x, 0);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  await expect(view.locator("mark")).toHaveCount(1);
  await writeButton.click();
  await expect(view.locator("mark")).toHaveCount(2);
});

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
      // The close button stacks idle and hovered icons (both 16px); check every svg each button renders.
      for (const title of ["Stop", "Expand All", "Collapse All", "Close Tab"])
        for (const icon of await find.getByRole("button", { name: title, exact: true }).last().locator("svg").all())
          await checkSize(icon);

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

test("Find Usages lines use the tree font and keep line numbers beside the snippet", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const modulePath = "/src/features/code-insight/usages.ts";
    const { useUsagesPopup } = await import(modulePath);
    const path = "/dev/acme-api/src/TaskScheduler.ts";
    const lines = Array<string>(1001).fill("");
    const usageLines = [6, 97, 1001];
    const text = "  scheduler.schedule(task);";
    for (const line of usageLines) lines[line - 1] = text;
    window.__ipc.handlers.fs_read_text = () => lines.join("\n");
    useUsagesPopup.setState({
      open: true,
      anchor: { x: 100, y: 150 },
      symbol: "scheduler",
      loading: false,
      groups: [
        {
          path,
          usages: usageLines.map((line) => ({
            path,
            line: line - 1,
            col: 2,
            endCol: 11,
            text,
          })),
        },
      ],
    });
  });

  const popup = page.getByRole("dialog", { name: "Usages", exact: true });
  const popupMatch = popup.getByRole("option").first().locator("mark");
  const popupFont = await popupMatch.evaluate((node) => getComputedStyle(node).fontFamily);
  await popup.getByRole("button", { name: /Open in Find Window/ }).click();

  const usages = page.getByRole("region", { name: "Find Usages", exact: true });
  await expect(usages.locator("mark")).toHaveCount(3);
  for (const width of [1200, 540]) {
    await page.setViewportSize({ width, height: 740 });
    for (const line of ["6", "97", "1001"]) {
      const row = usages.getByRole("treeitem").filter({ has: page.getByText(line, { exact: true }) });
      const mark = row.locator("mark");
      await expect(mark).toHaveText("scheduler");
      const number = await row.getByText(line, { exact: true }).evaluate((node) => {
        const text = new Range();
        text.selectNodeContents(node);
        const { right } = text.getBoundingClientRect();
        return { right, font: getComputedStyle(node).fontFamily, size: getComputedStyle(node).fontSize };
      });
      const snippet = await mark.evaluate((node) => ({
        left: node.getBoundingClientRect().left,
        font: getComputedStyle(node).fontFamily,
        size: getComputedStyle(node).fontSize,
      }));
      const treeFont = await row.evaluate((node) => getComputedStyle(node).fontFamily);
      expect(snippet.font).toBe(treeFont);
      expect(number.font).toBe(treeFont);
      expect(popupFont).not.toBe(treeFont);
      expect(snippet.size).toBe(number.size);
      expect(snippet.left - number.right).toBeCloseTo(4, 0);
    }
  }
});
