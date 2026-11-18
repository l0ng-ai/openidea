/**
 * At the smallest window the app allows (400 × 500, `tauri.conf.json`), search popups keep their
 * header on screen: titles stay on one line and every header control lies inside the popup.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function run(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    void executeAction(id);
  }, id);
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
      await stubDesktop(page);
      await page.evaluate(() => {
        window.__ipc.handlers.search_validate = () => null;
        window.__ipc.handlers.search_start = (args) => {
          const send = (event: unknown) => window.__ipc.send(args.onEvent, event);
          const text = "base=http://localhost:8080";
          setTimeout(() => {
            for (let i = 0; i < 12; i++) {
              const relPath = `config/endpoint-${i}.txt`;
              const matches = [{ line: 0, text, ranges: [[5, text.length]], textOffset: 0 }];
              send({
                type: "file",
                file: { path: `/dev/acme-api/${relPath}`, relPath, matches },
              });
            }
            send({
              type: "done",
              summary: {
                files: 12,
                matches: 12,
                limitHit: false,
                cancelled: false,
                elapsedMs: 4,
              },
            });
          }, 20);
          return null;
        };
      });
      await run(page, id);
      await page.getByRole("dialog").getByPlaceholder("Search").fill("http://localhost:8080");
      await expect(page.getByRole("dialog").locator("header [aria-live]")).toContainText(/match/);
      const dialog = page.getByRole("dialog");
      const title = dialog.getByText(id === "find.inPath" ? "Find in Files" : "Replace in Files", { exact: true });
      const count = dialog.getByText("12 matches in 12 files", { exact: true });
      for (const [width, height] of [
        [400, 500],
        [600, 700],
        [1120, 750],
      ]) {
        await page.setViewportSize({ width, height });
        await expectControlsFit(page);
        // Room enough for the title and the reporter's count: shown whole, on one line.
        for (const text of [title, count])
          expect(
            await text.evaluate((el) => el.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        for (const name of ["Search Context", "Pin Window"])
          await dialog.getByRole("button", { name, exact: true }).click({ trial: true });
      }
    });
  }

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
