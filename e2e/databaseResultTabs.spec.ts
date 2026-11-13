import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

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
  await menu(page)
    .getByRole("menuitem", { name: command.startsWith("Select ") ? new RegExp(`^${command}`) : command, exact: true })
    .click();
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
    "Close All but Pinned",
    "Pin Tab",
    "Rename Tab",
    "Select Next Tab⇧⌘]",
    "Select Previous Tab⇧⌘[",
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
  await expect(popup.getByRole("menuitem", { name: /^Select Previous Tab/ })).toBeFocused();
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
    await menu(page)
      .getByRole("menuitem", { name: /^Select Previous Tab/ })
      .click();
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

test("default tab shortcuts stay in results across repeated tab and grid switches, and remain editor shortcuts elsewhere", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await openFromTree(page, "settings.gradle.kts");
  const editors = page.getByRole("tablist", { name: "Editor tabs", exact: true });
  const build = editors.getByRole("tab", { name: "build.gradle.kts", exact: true });
  const settings = editors.getByRole("tab", { name: "settings.gradle.kts", exact: true });
  await seedResults(page);

  await tab(page, "Result 1").focus();
  for (const [shortcut, title, value] of [
    ["Meta+Shift+BracketRight", "Result 3", "third rows"],
    ["Meta+Shift+BracketRight", "Output"],
    ["Meta+Shift+BracketRight", "Result 1", "alpha rows"],
    ["Meta+Shift+BracketLeft", "Output"],
    ["Meta+Shift+BracketLeft", "Result 3", "third rows"],
  ]) {
    await page.keyboard.press(shortcut!);
    await selected(page, title!, value);
    await expect(settings).toHaveAttribute("aria-selected", "true");
  }

  // The grid is replaced on a tab switch; the second press must still belong to results.
  await page.getByRole("gridcell", { name: "third rows", exact: true }).click();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await selected(page, "Output");
  await page.keyboard.press("Meta+Shift+BracketRight");
  await selected(page, "Result 1", "alpha rows");
  await page.getByRole("gridcell", { name: "alpha rows", exact: true }).click();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await selected(page, "Result 2", "beta rows");
  await page.keyboard.press("Meta+Shift+BracketRight");
  await selected(page, "Result 3", "third rows");
  await expect(settings).toHaveAttribute("aria-selected", "true");

  await settings.click();
  await page.locator(".cm-content[contenteditable=true]").first().click();
  await page.keyboard.press("Meta+Shift+BracketRight");
  await expect(build).toHaveAttribute("aria-selected", "true");
  await selected(page, "Result 3", "third rows");
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await selected(page, "Result 3", "third rows");

  await tab(page, "Result 1").click({ button: "right" });
  await page.keyboard.press("Meta+Shift+BracketRight");
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await selected(page, "Result 3", "third rows");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
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

/** Runs `text` in console `path` through the production store, with the backend's answers stubbed. */
async function runConsole(page: Page, path: string, text: string) {
  await page.evaluate(
    async ({ path, text }) => {
      const bindingsPath = "/src/bindings.ts";
      const storePath = "/src/features/database/store.ts";
      const { commands } = await import(bindingsPath);
      const { executeConsole } = await import(storePath);
      commands.dbStatements = async (_id: string, sql: string) => {
        let from = 0;
        const data = sql.split(";").flatMap((part) => {
          const start = from + part.length - part.trimStart().length;
          from += part.length + 1;
          const st = part.trim();
          return st ? [{ from: start, to: start + st.length, text: st }] : [];
        });
        return { status: "ok", data };
      };
      commands.dbExecute = async (_r: unknown, _id: string, statements: { text: string }[]) => ({
        status: "ok",
        data: statements.map((statement) => ({
          statement,
          error: null,
          result: {
            statement: statement.text,
            columns: [{ name: "payload", typeName: "text" }],
            rows: [[/'(.*)'/.exec(statement.text)![1]]],
            affected: null,
            hasMore: false,
            elapsedMs: 1,
            executionMs: 1,
          },
        })),
      });
      await executeConsole(path, text, 0, text.length);
    },
    { path, text },
  );
}

test("console runs replace their unpinned results; pinned results stay until Close All but Pinned", async ({
  workbench: page,
}) => {
  await seedResults(page);
  const strip = page.getByRole("tablist", { name: "Results", exact: true }).getByRole("tab");
  await choose(page, "Result 1", "Close All");
  // The seeded Output line's id would collide with the ids of the lines the runs log.
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const { useDatabase } = await import(storePath);
    useDatabase.setState({ output: [] });
  });
  await runConsole(page, "alpha-console.sql", "SELECT 'one'");
  const n = Number(/\d+/.exec((await strip.nth(1).textContent())!)![0]);
  const result = (run: number, index = 1) => `Result ${n + run}${index > 1 ? `-${index}` : ""}`;
  await runConsole(page, "alpha-console.sql", "SELECT 'two'");
  await expect(strip).toHaveText(["Output", result(1)]);
  await selected(page, result(1), "two");

  const pin = page.getByRole("button", { name: "Pin Tab", exact: true });
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await runConsole(page, "alpha-console.sql", "SELECT 'three'; SELECT 'four'");
  await runConsole(page, "beta-console.sql", "SELECT 'beta'");
  await expect(strip).toHaveText(["Output", result(1), result(2), result(2, 2), result(3)]);
  await selected(page, result(3), "beta");

  await tab(page, result(2)).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Close All but Pinned", exact: true })).toBeEnabled();
  await menu(page).getByRole("menuitem", { name: "Pin Tab", exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  await runConsole(page, "alpha-console.sql", "SELECT 'five'");
  await expect(strip).toHaveText(["Output", result(1), result(2), result(4), result(3)]);
  await selected(page, result(4), "five");
  await expect(pin).toHaveAttribute("aria-pressed", "false");

  await tab(page, result(2)).click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await choose(page, result(3), "Close All but Pinned");
  await expect(strip).toHaveText(["Output", result(1), result(2)]);
  await selected(page, result(2), "three");
  await tab(page, result(1)).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Unpin Tab", exact: true })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Close All but Pinned", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  // A pinned tab's close button is its Unpin button; middle-click leaves it open.
  const slot = tab(page, result(1)).locator("..");
  await expect(slot.getByRole("button", { name: "Close Tab", exact: true })).toHaveCount(0);
  await tab(page, result(1)).click({ button: "middle" });
  await expect(strip).toHaveText(["Output", result(1), result(2)]);
  await slot.getByRole("button", { name: "Unpin Tab", exact: true }).click();
  await selected(page, result(2), "three");
  await slot.getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(strip).toHaveText(["Output", result(2)]);
});

test("Tab goes from a result tab to its first cell, and the result toolbar is one stop back", async ({
  workbench: page,
}) => {
  await openFromTree(page, "README.md");
  await seedResults(page);
  const grid = page.getByRole("grid");
  const cell = page.getByRole("gridcell", { name: "beta rows", exact: true });
  await expect(cell).toHaveAttribute("aria-selected", "false");

  await tab(page, "Result 2").focus();
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  await expect(cell).toHaveAttribute("aria-selected", "true");

  const toolbar = page.getByRole("toolbar", { name: "Result actions", exact: true });
  await page.keyboard.press("Shift+Tab");
  await expect(toolbar.getByRole("button", { name: "Table", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(toolbar.getByRole("button", { name: "Chart", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tab(page, "Result 2")).toBeFocused();
  // The toolbar is entered at the control used last.
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(toolbar.getByRole("button", { name: "Chart", exact: true })).toBeFocused();
});
