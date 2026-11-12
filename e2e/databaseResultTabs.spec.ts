import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const edgeTitle = "Result 3 — a long query result at the edge of the Services pane";
const bindings = { "alpha-console.sql": "alpha", "beta-console.sql": "beta" };

/** Seed query outcomes, but use the production Services host, tabs, menus and dialogs. */
async function seedResults(page: Page, edge = false) {
  await page.evaluate(
    async ({ edge, edgeTitle, bindings }) => {
      const storePath = "/src/features/database/store.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const { useDatabase, RESULTS_VIEW } = await import(storePath);
      const { showServiceView } = await import(contributionsPath);
      useDatabase.setState({
        loaded: true,
        sources: [
          { id: "alpha", name: "Alpha database", driver: "sqlite", readOnly: true },
          { id: "beta", name: "Beta database", driver: "sqlite", readOnly: true },
        ],
        consoles: bindings,
        results: ["alpha rows", "beta rows", "third rows"].map((value, index) => {
          const text = `SELECT '${value}' AS payload`;
          return {
            id: index + 1,
            title: edge && index === 2 ? edgeTitle : `Result ${index + 1}`,
            path: index === 1 ? "beta-console.sql" : "alpha-console.sql",
            sourceId: index === 1 ? "beta" : "alpha",
            outcome: {
              statement: { text, from: 0, to: text.length },
              error: null,
              result: {
                statement: text,
                columns: [{ name: "payload", typeName: "text" }],
                rows: [[value]],
                affected: null,
                hasMore: false,
                elapsedMs: 1,
                executionMs: 1,
              },
            },
            page: 0,
            pageSize: 500,
          };
        }),
        activeResult: 2,
        output: [{ id: 1, time: 0, kind: "info", text: "Seeded query output" }],
      });
      showServiceView(RESULTS_VIEW);
    },
    { edge, edgeTitle, bindings },
  );
  await expect(page.getByRole("tablist", { name: "Results", exact: true })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "beta rows", exact: true })).toBeVisible();
}

function tab(page: Page, name: string) {
  return page.getByRole("tablist", { name: "Results", exact: true }).getByRole("tab", { name, exact: true });
}

function menu(page: Page) {
  return page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Close All", exact: true }) });
}

async function choose(page: Page, title: string, command: string) {
  await tab(page, title).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: command, exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
}

async function selected(page: Page, title: string, value?: string) {
  await expect(tab(page, title)).toHaveAttribute("aria-selected", "true");
  if (value) await expect(page.getByRole("gridcell", { name: value, exact: true })).toBeVisible();
}

test("result context menu fits the viewport, responds to hover and keyboard, and dismisses without selecting", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await seedResults(page, true);
  const target = tab(page, edgeTitle);
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("Result tab is not visible");
  const point = { x: bounds.x + bounds.width - 8, y: bounds.y + bounds.height / 2 };
  expect(point.x).toBeGreaterThan(800 - 260);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const popup = menu(page);
  await expect(popup.getByRole("menuitem")).toHaveText([
    "Close",
    "Close Others",
    "Close All",
    "Rename Tab",
    "Select Next Tab",
    "Select Previous Tab",
  ]);
  await expect(popup.getByRole("separator")).toHaveCount(2);
  await selected(page, "Result 2", "beta rows");
  await expect
    .poll(async () => {
      const box = await popup.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 800 && box.y + box.height <= 600;
    })
    .toBe(true);
  const popupBounds = await popup.boundingBox();
  if (!popupBounds) throw new Error("Result menu is not visible");
  expect(popupBounds.x).toBeLessThan(point.x);
  // A bounded menu can still be clipped by a tool-window ancestor. Hit-test every row.
  for (const item of await popup.getByRole("menuitem").all()) {
    await expect(item).toBeVisible();
    expect(
      await item.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }),
    ).toBe(true);
  }
  const rename = popup.getByRole("menuitem", { name: "Rename Tab", exact: true });
  await rename.hover();
  await expect(rename).toHaveAttribute("tabindex", "0");
  expect(await rename.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    await popup
      .getByRole("menuitem", { name: "Close", exact: true })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await selected(page, "Result 2", "beta rows");

  await target.click({ button: "right" });
  await page.getByRole("tree", { name: "Project", exact: true }).click({ position: { x: 10, y: 10 } });
  await expect(popup).toHaveCount(0);
  await selected(page, "Result 2", "beta rows");

  await target.focus();
  await target.press("Shift+F10");
  await expect(popup.getByRole("menuitem", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popup.getByRole("menuitem", { name: "Close Others", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(popup.getByRole("menuitem", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(popup.getByRole("menuitem", { name: "Select Previous Tab", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  await selected(page, "Result 1", "alpha rows");
});

for (const [theme, label] of [
  ["solarized-light", "Solarized Light"],
  ["solarized-dark", "Solarized Dark"],
]) {
  test(`${label}: retains the inactive context-menu target's hover until dismissal without selecting it`, async ({
    workbench: page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Meta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings
      .locator('[role="treeitem"][aria-level="2"]')
      .filter({ hasText: /^Appearance$/ })
      .click();
    await settings.getByRole("button", { name: "Theme", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await settings.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", theme);
    await page.keyboard.press("Escape");
    await seedResults(page);
    const target = tab(page, "Result 1");
    const surface = target.locator("..");
    const other = tab(page, "Result 3");
    const otherSurface = other.locator("..");
    await page.mouse.move(0, 0);
    const idle = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);
    const selectedColor = await tab(page, "Result 2")
      .locator("..")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await target.hover();
    const hovered = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(hovered).not.toBe(idle);

    await target.click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "Close", exact: true }).hover();
    expect(await surface.evaluate((element) => element.matches(":hover"))).toBe(false);
    await expect(surface).toHaveCSS("background-color", hovered);
    await expect(surface.getByRole("button", { name: "Close Tab", exact: true })).toHaveCSS("opacity", "1");
    await selected(page, "Result 2", "beta rows");
    await page.screenshot({ path: info.outputPath("context-menu-owner.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(surface).toHaveCSS("background-color", idle);
    await expect(surface.getByRole("button", { name: "Close Tab", exact: true })).toHaveCSS("opacity", "0");

    await target.focus();
    await target.press("Shift+F10");
    await menu(page).getByRole("menuitem", { name: "Close", exact: true }).hover();
    await expect(surface).toHaveCSS("background-color", hovered);
    await selected(page, "Result 2", "beta rows");
    await page.getByRole("tree", { name: "Project", exact: true }).click({ position: { x: 10, y: 10 } });
    await expect(menu(page)).toHaveCount(0);
    await expect(surface).toHaveCSS("background-color", idle);

    await target.click({ button: "right" });
    await other.click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "Close", exact: true }).hover();
    await expect(surface).toHaveCSS("background-color", idle);
    await expect(otherSurface).toHaveCSS("background-color", hovered);
    await selected(page, "Result 2", "beta rows");
    await menu(page).getByRole("menuitem", { name: "Select Previous Tab", exact: true }).click();
    await expect(menu(page)).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(otherSurface).toHaveCSS("background-color", idle);
    await selected(page, "Result 1", "alpha rows");

    await target.click({ button: "right" });
    await menu(page).getByRole("menuitem", { name: "Close", exact: true }).hover();
    await expect(surface).toHaveCSS("background-color", selectedColor);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
  });
}

test("renames the clicked inactive result without changing its rows and navigates through Output with wraparound", async ({
  workbench: page,
}) => {
  await seedResults(page);
  await tab(page, "Result 1").focus();
  await tab(page, "Result 1").press("Shift+F10");
  await selected(page, "Result 2", "beta rows");
  await menu(page).getByRole("menuitem", { name: "Rename Tab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename Tab", exact: true });
  const input = dialog.getByRole("textbox", { name: "Tab name:", exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Result 1");
  await input.fill("Discarded name");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, "Result 1")).toBeVisible();
  await selected(page, "Result 2", "beta rows");

  await choose(page, "Result 1", "Rename Tab");
  await input.fill("   ");
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
  await input.fill("  Customer summary  ");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, "Result 1")).toHaveCount(0);
  await expect(tab(page, "Customer summary")).toBeVisible();
  await selected(page, "Result 2", "beta rows");
  await tab(page, "Customer summary").click();
  await selected(page, "Customer summary", "alpha rows");

  await choose(page, "Result 3", "Select Next Tab");
  await selected(page, "Result 2", "beta rows");
  await choose(page, "Result 3", "Select Next Tab");
  await selected(page, "Result 3", "third rows");
  await choose(page, "Customer summary", "Select Next Tab");
  await selected(page, "Output");
  await expect(page.getByText("Seeded query output", { exact: true })).toBeVisible();
  await choose(page, "Customer summary", "Select Next Tab");
  await selected(page, "Customer summary", "alpha rows");
  await choose(page, "Result 3", "Select Previous Tab");
  await selected(page, "Output");
  await choose(page, "Result 2", "Select Previous Tab");
  await selected(page, "Result 3", "third rows");
});

test("rename owns deletion and Cmd+Enter without editing the previously focused query", async ({ workbench: page }) => {
  await seedResults(page);
  await page.evaluate(async () => {
    // This callback runs in the browser; a static import would load into the Node test runner.
    const path = "/src/workbench/contributions.ts";
    const { editorService } = await import(path);
    await editorService().openFile("alpha-console.sql", { focus: true });
  });
  const content = page.locator(".cm-content[contenteditable=true]").first();
  await content.click();
  await page.keyboard.press("Meta+a");
  const query = "SELECT 'keep this query';\nSELECT 2;";
  await page.keyboard.insertText(query);
  await page.keyboard.press("Meta+ArrowUp");
  await expect(content).toHaveText(query.replace("\n", ""));

  await choose(page, "Result 1", "Rename Tab");
  const dialog = page.getByRole("dialog", { name: "Rename Tab", exact: true });
  const input = dialog.getByRole("textbox", { name: "Tab name:", exact: true });
  await input.fill("");
  await input.press("Meta+Enter");
  await expect(dialog).toBeVisible();
  await expect(content).toHaveText(query.replace("\n", ""));
  await input.fill("Customer summary");
  await input.press("Meta+Backspace");
  await expect(input).toBeFocused();
  await expect(content).toHaveText(query.replace("\n", ""));
  if (process.platform === "darwin") await expect(input).toHaveValue("");

  await input.fill("Customer summary");
  await input.press("Alt+Backspace");
  await expect(input).toBeFocused();
  await expect(content).toHaveText(query.replace("\n", ""));
  if (process.platform === "darwin") await expect(input).toHaveValue("Customer ");
  await input.fill("Customer summary");
  await input.press("Meta+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, "Customer summary")).toBeVisible();
  await expect(content).toHaveText(query.replace("\n", ""));

  // The editor's own Delete Line shortcut still works after the dialog closes.
  await content.click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+Backspace");
  await expect(content.locator(".cm-line").filter({ hasText: /SELECT/ })).toHaveCount(1);
});

test("closes clicked results, other results and all results without removing Output, sources or console bindings", async ({
  workbench: page,
}) => {
  await seedResults(page);
  await tab(page, "Output").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Close", exact: true })).toBeDisabled();
  await expect(menu(page).getByRole("menuitem", { name: "Rename Tab", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await choose(page, "Result 1", "Close");
  await expect(tab(page, "Result 1")).toHaveCount(0);
  await selected(page, "Result 2", "beta rows");
  await choose(page, "Result 3", "Close Others");
  await expect(page.getByRole("tablist", { name: "Results", exact: true }).getByRole("tab")).toHaveText([
    "Output",
    "Result 3",
  ]);
  await selected(page, "Result 3", "third rows");
  await choose(page, "Result 3", "Close All");
  await expect(page.getByRole("tablist", { name: "Results", exact: true }).getByRole("tab")).toHaveText(["Output"]);
  await selected(page, "Output");
  await expect(page.getByText("Seeded query output", { exact: true })).toBeVisible();

  await seedResults(page);
  await choose(page, "Output", "Close Others");
  await expect(page.getByRole("tablist", { name: "Results", exact: true }).getByRole("tab")).toHaveText(["Output"]);
  await selected(page, "Output");
  // These are lifetime invariants, not substitutes for the visible menu/grid assertions above.
  expect(
    await page.evaluate(async () => {
      const storePath = "/src/features/database/store.ts";
      const { useDatabase } = await import(storePath);
      const { sources, consoles } = useDatabase.getState();
      return { sources: sources.map((source: { id: string }) => source.id), consoles };
    }),
  ).toEqual({ sources: ["alpha", "beta"], consoles: bindings });
  await page.evaluate(async () => {
    const contributionsPath = "/src/workbench/contributions.ts";
    const { toolWindowService } = await import(contributionsPath);
    toolWindowService().show("database");
  });
  await expect(page.getByRole("treeitem", { name: "Alpha database", exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Beta database", exact: true })).toBeVisible();
});
