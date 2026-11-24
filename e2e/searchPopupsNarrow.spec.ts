/**
 * At the smallest window the app allows (400 × 500, `tauri.conf.json`), search popups keep their
 * header on screen: titles stay on one line and every header control lies inside the popup.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const LONG_RESULT_PATH = "config/RegionalOrderReconciliationEndpointsForSandboxEnvironments.txt";

async function run(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    void executeAction(id);
  }, id);
}

async function stubFindMatches(page: Page, firstPath = LONG_RESULT_PATH) {
  await stubDesktop(page);
  await page.evaluate((longPath) => {
    window.__ipc.handlers.search_validate = () => null;
    window.__ipc.handlers.search_start = (args) => {
      const send = (event: unknown) => window.__ipc.send(args.onEvent, event);
      const text = "base=http://localhost:8080";
      setTimeout(() => {
        for (let i = 0; i < 12; i++) {
          const relPath = i === 0 ? longPath : `config/endpoint-${i}.txt`;
          const lines = i === 0 ? [12344, 12345] : [0];
          const matches = lines.map((line) => ({ line, text, ranges: [[5, text.length]], textOffset: 0 }));
          send({
            type: "file",
            file: { path: `/dev/acme-api/${relPath}`, relPath, matches },
          });
        }
        send({
          type: "done",
          summary: { files: 12, matches: 13, limitHit: false, cancelled: false, elapsedMs: 4 },
        });
      }, 20);
      return null;
    };
  }, firstPath);
}

async function expectControlsFit(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const problems = await dialog.evaluate((dialog) => {
    const box = dialog.getBoundingClientRect();
    const out: string[] = [];
    // Scope tabs scroll inside their strip and list rows inside their list; the strips must fit.
    const controls = [...dialog.querySelectorAll("button, input, [role=tablist]")].filter(
      (el) => el.matches("[role=tablist]") || !el.closest("[role=tablist], [role=listbox]"),
    );
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
        out.push(
          `${el.getAttribute("aria-label") ?? el.textContent} at ${r.left}–${r.right}, popup ${box.left}–${box.right}`,
        );
    }
    return out;
  });
  expect(problems).toEqual([]);
}

test.describe("search popups at the minimum window width", () => {
  test.beforeEach(async ({ workbench: page }) => {
    await page.setViewportSize({ width: 400, height: 500 });
  });

  for (const id of ["find.inPath", "find.replaceInPath"]) {
    test(`${id} keeps its title, count and buttons visible`, async ({ workbench: page }) => {
      await stubFindMatches(page);
      await run(page, id);
      await page.getByRole("dialog").getByPlaceholder("Search").fill("http://localhost:8080");
      await expect(page.getByRole("dialog").locator("header [aria-live]")).toContainText(/match/);
      const dialog = page.getByRole("dialog");
      const title = dialog.getByText(id === "find.inPath" ? "Find in Files" : "Replace in Files", { exact: true });
      const count = dialog.getByText("13 matches in 12 files", { exact: true });
      const line = dialog.getByText("12345", { exact: true });
      for (const [width, height] of [
        [400, 500],
        [600, 700],
        [1120, 750],
      ] as const) {
        await page.setViewportSize({ width, height });
        await expectControlsFit(page);
        // Room enough for the title and the reporter's count: shown whole, on one line.
        for (const text of [title, count])
          expect(
            await text.evaluate((el) => el.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        await expect(line).toBeVisible();
        expect(
          await line.evaluate(
            (el) => el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right + 0.5,
          ),
          "the line number fits even when the long filename is elided",
        ).toBe(true);
        await expect(line.locator("..").getByTitle(LONG_RESULT_PATH)).toBeVisible();
        for (const name of ["Search Context", "Pin Window"])
          await dialog.getByRole("button", { name, exact: true }).click({ trial: true });
      }
    });
  }

  test("directory scope gives the path field room at the minimum width", async ({ workbench: page }) => {
    await stubDesktop(page);
    await run(page, "find.inPath");
    const dialog = page.getByRole("dialog", { name: "Find in Files" });
    await dialog.getByRole("tab", { name: "Directory", exact: true }).click();
    const input = dialog.getByRole("textbox", { name: "Directory", exact: true });
    await expect(input).toBeVisible();
    const { width } = (await input.boundingBox())!;
    expect(width).toBeGreaterThan(200);
    await expectControlsFit(page);
    await dialog.getByRole("button", { name: /Browse/ }).click({ trial: true });
  });

  test("multi-line search and replacement leave room for matches and scroll inside their fields", async ({
    workbench: page,
  }) => {
    await stubFindMatches(page);
    await run(page, "find.replaceInPath");
    const dialog = page.getByRole("dialog", { name: "Replace in Files" });
    const search = dialog.getByRole("textbox", { name: "Text to find" });
    const replacement = dialog.getByRole("textbox", { name: "Replace with" });
    const query = "base=http://localhost:8080\nregion=eu-west\nmode=batch\nverify=true\nretry=2\ntimeout=30";
    const changed = query.replace("localhost:8080", "localhost:9443").replace("retry=2", "retry=4");
    await search.fill(query);
    await replacement.fill(changed);
    for (const field of [search, replacement]) {
      const visibleLines = await field.evaluate((el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight));
      expect(visibleLines).toBeCloseTo(3);
      await field.press("Control+End");
      await expect.poll(() => field.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    }
    await expect(search).toHaveValue(query);
    await expect(replacement).toHaveValue(changed);
    await expect(dialog.getByRole("listbox", { name: "Matches" }).getByRole("option").first()).toBeInViewport();
    const calls = await ipcCalls(page, "search_start");
    expect(calls.some(({ query: sent }) => (sent as { pattern: string }).pattern === query)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Replace All", exact: true })).toBeInViewport({ ratio: 1 });

    await replacement.fill("updated");
    await expect(replacement).toHaveAttribute("rows", "1");
  });

  test("Replace in Files keeps its footer actions together as the window narrows", async ({ workbench: page }) => {
    await page.setViewportSize({ width: 1120, height: 750 });
    await openFromTree(page, "settings.gradle.kts");
    await stubFindMatches(page);
    await run(page, "find.replaceInPath");
    const dialog = page.getByRole("dialog", { name: "Replace in Files" });
    const search = dialog.getByRole("textbox", { name: "Text to find" });
    await search.fill("http://localhost:8080");
    await expect(dialog.locator("header [aria-live]")).toContainText("13 matches in 12 files");
    await search.press("Shift+ArrowDown");
    await search.press("Shift+ArrowDown");

    const footer = dialog.locator("footer");
    const open = footer.getByRole("button", { name: "Open in Find Window", exact: true });
    const shortcut = footer.getByText(/^(Ctrl\+Enter|⌘↵)$/);
    const replaceAll = footer.getByRole("button", { name: "Replace All", exact: true });
    const replaceSelected = footer.getByRole("button", { name: "Replace 3 Occurrences", exact: true });
    await expect(replaceSelected).toBeEnabled();
    for (const [width, height] of [
      [400, 500],
      [1120, 750],
    ] as const) {
      await page.setViewportSize({ width, height });
      const [key, find, all, selected] = await Promise.all([
        shortcut.boundingBox(),
        open.boundingBox(),
        replaceAll.boundingBox(),
        replaceSelected.boundingBox(),
      ]);
      if (!key || !find || !all || !selected) throw new Error("Expected all footer actions to be visible");
      expect(Math.abs(key.y + key.height / 2 - find.y - find.height / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(all.y - selected.y)).toBeLessThanOrEqual(1);
      await expectControlsFit(page);
      await expect(footer).toBeInViewport({ ratio: 1 });
      await expect(shortcut).toHaveCSS("font-size", "12px");
      await open.click({ trial: true });
      await replaceSelected.click({ trial: true });
    }
    await search.press("Meta+Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Find", exact: true })).toContainText("http://localhost:8080");
  });

  for (const id of [
    "navigate.searchEverywhere",
    "navigate.searchText",
    "navigate.gotoFile",
    "navigate.gotoClass",
    "navigate.gotoSymbol",
    "navigate.findAction",
    "navigate.recentFiles",
    "navigate.recentLocations",
  ]) {
    test(`${id} keeps its header controls inside the popup`, async ({ workbench: page }) => {
      await run(page, id);
      await expectControlsFit(page);
    });
  }
});

test("Find in Files prioritizes the preview and remembers an adjusted split", async ({ workbench: page }) => {
  await stubFindMatches(page);
  await run(page, "find.inPath");
  const dialog = page.getByRole("dialog", { name: "Find in Files" });
  await dialog.getByPlaceholder("Search").fill("http://localhost:8080");
  const results = dialog.locator("[data-panel][id=results]");
  const preview = dialog.locator("[data-panel][id=preview]");
  const handle = dialog.getByTestId("find-popup-split").getByRole("separator");
  const resultsShare = async () => {
    const resultHeight = (await results.boundingBox())!.height;
    const previewHeight = (await preview.boundingBox())!.height;
    return resultHeight / (resultHeight + previewHeight);
  };
  await expect(handle).toBeAttached();
  await expect.poll(resultsShare).toBeCloseTo(0.33, 2);
  await handle.press("ArrowUp");
  await expect.poll(resultsShare).toBeLessThan(0.31);
  const adjusted = await resultsShare();
  await page.setViewportSize({ width: 400, height: 500 });
  await expect.poll(resultsShare).toBeGreaterThan(adjusted + 0.02);
  await dialog.getByPlaceholder("Search").press("Escape");
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1400, height: 900 });
  await run(page, "find.inPath");
  await expect(handle).toBeAttached();
  await expect.poll(resultsShare).toBeCloseTo(adjusted, 2);
});

test("Find in Files keeps the file and its parent folder visible in the preview caption", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 400, height: 570 });
  const prefix = "config/generated/regional-integrations/sandbox/development/notifications";
  const name = "RegionalLedgerSettings.txt";
  const path = `${prefix}/runtime/${name}`;
  await stubFindMatches(page, path);
  await run(page, "find.inPath");
  const dialog = page.getByRole("dialog", { name: "Find in Files" });
  const search = dialog.getByPlaceholder("Search");
  await search.fill("http://localhost:8080");
  const preview = dialog.locator("[data-panel][id=preview]");
  const caption = preview.getByTitle(path, { exact: true });
  const folder = caption.getByText("/runtime", { exact: true });
  const beginning = caption.getByText(prefix, { exact: true });
  await expect(caption.getByText(name, { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(folder).toBeInViewport({ ratio: 1 });
  await expect(folder).toHaveCSS("font-size", "13px");
  expect(await beginning.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await folder.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await expect(preview.getByTitle("config/endpoint-1.txt", { exact: true })).toContainText("endpoint-1.txt");
});
