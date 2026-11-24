import { doubleShift, expect, stubDesktop, test } from "./fixtures";

test("Search Everywhere keeps line numbers visible beside long Text result filenames", async ({ workbench: page }) => {
  const relPath = "config/InternationalSettlementReconciliationEndpointsForStagingEnvironments.ts";
  const query = "settlementEndpoint";
  const text = `const ${query} = "/staging/settlement";`;
  await stubDesktop(page);
  await page.evaluate(
    ({ relPath, text, query }) => {
      window.__ipc.handlers.search_start = (args) => {
        setTimeout(() => {
          const matches = [12344, 12345].map((line) => ({
            line,
            text,
            ranges: [[6, 6 + query.length]],
            textOffset: 0,
          }));
          window.__ipc.send(args.onEvent, {
            type: "file",
            file: { path: `/dev/acme-api/${relPath}`, relPath, matches },
          });
          window.__ipc.send(args.onEvent, {
            type: "done",
            summary: { files: 1, matches: 2, limitHit: false, cancelled: false, elapsedMs: 4 },
          });
        }, 20);
        return null;
      };
    },
    { relPath, text, query },
  );

  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  const search = dialog.getByRole("combobox", { name: "Search query" });
  await search.fill(query);
  const rows = dialog.getByRole("option");
  await expect(rows).toHaveCount(2);
  for (const width of [920, 440]) {
    await page.setViewportSize({ width, height: 640 });
    for (const line of [12345, 12346]) {
      const row = rows.filter({ hasText: String(line) });
      await expect(row.locator("mark")).toHaveText(query);
      expect(
        await row.evaluate((el) => {
          const location = el.lastElementChild!;
          const lineText = location.lastChild!;
          const range = document.createRange();
          range.selectNodeContents(lineText);
          const bounds = range.getBoundingClientRect();
          const clip = location.getBoundingClientRect();
          return bounds.width > 0 && bounds.left >= clip.left && bounds.right <= clip.right + 1;
        }),
      ).toBe(true);
      await expect(row.getByText(relPath.split("/").at(-1)!, { exact: true })).toHaveAttribute("title", relPath);
    }
  }
  await search.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
});
import type { Page } from "@playwright/test";

test("action names stay readable beside shortcuts and categories", async ({ workbench: page }) => {
  const titles = ["Reconcile warehouse totals", "Reconcile settlement exports"];
  const shortcuts = await page.evaluate(async (titles) => {
    const actionsModule = "/src/platform/actions.ts";
    const keymapModule = "/src/platform/keymap.ts";
    const { registerActions, executeAction } = await import(/* @vite-ignore */ actionsModule);
    const platformModule = "/src/platform/platformInfo.ts";
    const { registerExtensionBindings, shortcutLabel } = await import(/* @vite-ignore */ keymapModule);
    const { usePlatform } = await import(/* @vite-ignore */ platformModule);
    usePlatform.setState({ os: "windows" });
    const ids = ["review.reconcileWarehouse", "review.reconcileSettlement"];
    const bindings = ["Ctrl+K Ctrl+R", "Ctrl+Alt+Shift+PageDown Ctrl+Alt+Shift+PageUp"];
    registerActions(
      titles.map((title, index) => ({
        id: ids[index]!,
        title,
        category: "Warehouse reconciliation and settlement reports",
        icon: "check",
        run: () => document.body.setAttribute("data-review-action", title),
      })),
    );
    ids.forEach((id, index) => registerExtensionBindings(id, [bindings[index]!]));
    await executeAction("navigate.findAction");
    return ids.map((id) => shortcutLabel(id) as string);
  }, titles);
  const dialog = page.locator('[role="dialog"]:has(#se-query)');
  await dialog.getByRole("combobox", { name: "Search query" }).fill("Reconcile");

  for (const width of [400, 1120]) {
    await page.setViewportSize({ width, height: 630 });
    for (const [index, title] of titles.entries()) {
      const row = dialog.getByRole("option").filter({ hasText: title });
      const keys = row.getByText(shortcuts[index]!, { exact: true });
      await expect(keys).toBeAttached();
      const geometry = await keys.evaluate((el) => {
        const name = el.previousElementSibling!.getBoundingClientRect();
        const main = el.parentElement!.getBoundingClientRect();
        const key = el.getBoundingClientRect();
        return { name: name.width, inside: key.left >= name.right && key.right <= main.right + 1 };
      });
      expect(geometry.name).toBeGreaterThanOrEqual(80);
      expect(geometry.inside).toBe(true);
      await expect(keys).toHaveCSS("font-size", "12px");
      await expect(keys).toHaveCSS("font-weight", "600");
      await expect(keys).toHaveAttribute("title", shortcuts[index]!);
      if (index === 0) expect(await keys.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  }

  await dialog.getByRole("option").filter({ hasText: titles[1]! }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-review-action", titles[1]!);
});

async function searchFiles(page: Page) {
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.find_files = () =>
      Array.from({ length: 24 }, (_, i) => ({
        path: `/dev/acme-api/src/main/kotlin/com/acme/orders/service/OrderService${i}.kt`,
        relPath: `src/main/kotlin/com/acme/orders/service/OrderService${i}.kt`,
        score: 100 - i,
        indices: [],
      }));
  });
  await doubleShift(page);
  const dialog = page.locator('[role="dialog"]:has(#se-query)');
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Search query" }).fill("OrderService");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  return dialog;
}

test("the popup leaves room around results with or without the preview", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const dialog = await searchFiles(page);
  const preview = dialog.getByRole("region", { name: "Preview", exact: true });
  const footer = dialog.locator("footer");
  const query = dialog.getByRole("combobox", { name: "Search query" });
  const field = query.locator("..");
  await expect(query).toBeFocused();
  await expect(field).toHaveCSS("border-top-width", "0px");
  await expect(field).toHaveCSS("border-left-width", "0px");
  await expect(field).toHaveCSS("border-bottom-width", "1px");
  const focusedDivider = await field.evaluate((el) => getComputedStyle(el).borderBottomColor);
  await dialog.getByRole("button", { name: "Search history", exact: true }).focus();
  await expect(field).toHaveCSS("border-bottom-color", focusedDivider);
  await dialog.getByRole("tab", { name: "Files", exact: true }).focus();
  await expect(field).not.toHaveCSS("border-bottom-color", focusedDivider);
  await query.focus();
  const expectPopupSize = async () => {
    const { width, height } = (await dialog.boundingBox())!;
    expect(width).toBeCloseTo(700, 0);
    expect(height).toBeCloseTo(600, 0);
    await expect(footer).toBeInViewport({ ratio: 1 });
  };

  await expect(preview).toBeVisible();
  await expectPopupSize();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview).toBeHidden();
  await expectPopupSize();
});

for (const count of [1, 2, 24]) {
  test(`without the preview the results list shows its rows (${count} results)`, async ({ workbench: page }) => {
    await stubDesktop(page);
    await page.evaluate((count) => {
      window.__ipc.handlers.find_files = () =>
        Array.from({ length: count }, (_, i) => ({
          path: `/dev/acme-api/src/main${i}.js`,
          relPath: `src/main${i}.js`,
          score: 100 - i,
          indices: [],
        }));
    }, count);
    await doubleShift(page);
    const dialog = page.locator('[role="dialog"]:has(#se-query)');
    await dialog.getByRole("tab", { name: "Files", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Search query" }).fill("main");
    await expect(dialog.getByRole("separator", { name: "Preview", exact: true })).toBeHidden();
    const list = dialog.getByRole("listbox", { name: "Results" });
    await expect
      .poll(async () => (await list.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(Math.min(count, 5) * 24);
  });
}

test("preview splitter resizes with mouse and keyboard, keeps query focus and remembers its ratio", async ({
  workbench: page,
}) => {
  const dialog = await searchFiles(page);
  const query = dialog.getByRole("combobox", { name: "Search query" });
  const list = dialog.getByRole("listbox", { name: "Results" });
  const handle = dialog.getByRole("separator", { name: "Preview", exact: true });
  await expect(handle).toBeVisible();
  const initial = (await list.boundingBox())!.height;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 70, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(initial + 50);
  await expect(query).toBeFocused();
  const dragged = (await list.boundingBox())!.height;
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(handle).toBeHidden();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(async () => Math.abs((await list.boundingBox())!.height - dragged)).toBeLessThan(2);
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(dragged + 10);
  await expect(handle).toBeFocused();
  const resized = (await list.boundingBox())!.height;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+o");
  await expect(query).toHaveValue("OrderService");
  await expect.poll(async () => Math.abs((await list.boundingBox())!.height - resized)).toBeLessThan(2);
  await expect(query).toBeFocused();
});

test("keyboard selection stays in view, announces the active result and updates the preview", async ({
  workbench: page,
}) => {
  const dialog = await searchFiles(page);
  const query = dialog.getByRole("combobox", { name: "Search query" });
  const list = dialog.getByRole("listbox", { name: "Results" });
  const preview = dialog.getByRole("region", { name: "Preview", exact: true });
  await expect(preview.locator(".cm-content")).toHaveAttribute("aria-label", /OrderService0\.kt$/);
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowDown");
  await expect(query).toBeFocused();
  const lead = list.locator('[data-lead="true"]');
  await expect(lead).toContainText("OrderService18.kt");
  await expect(preview.locator(".cm-content")).toHaveAttribute("aria-label", /OrderService18\.kt$/);
  await expect(query).toHaveAttribute("aria-activedescendant", (await lead.getAttribute("id"))!);
  const bounds = (await list.boundingBox())!;
  const row = (await lead.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const handle = (await dialog.getByRole("separator", { name: "Preview", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 45, { steps: 8 });
  await page.mouse.up();
  await expect(query).toBeFocused();
  await expect
    .poll(async () => {
      const bounds = (await list.boundingBox())!;
      const row = (await lead.boundingBox())!;
      return row.y >= bounds.y - 1 && row.y + row.height <= bounds.y + bounds.height + 1;
    })
    .toBe(true);
});

for (const locale of ["en", "zh"]) {
  test(`${locale} tabs and query fit narrow windows at normal and 125% scale`, async ({ workbench: page }) => {
    const dialog = await searchFiles(page);
    await page.evaluate(async (locale) => {
      const path = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ path)).setLocale(locale);
    }, locale);
    for (const size of [
      { width: 1000, height: 760 },
      { width: 720, height: 608 },
      { width: 520, height: 608 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const header = dialog.locator('[data-dialog-drag=""]').first();
      await expect.poll(() => header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const input = dialog.locator("#se-query");
      expect((await input.boundingBox())!.width).toBeGreaterThan(160);
      for (let i = 0; i < 6; i++) {
        await input.press("Tab");
        await expect(input).toBeFocused();
        const selected = dialog.getByRole("tab", { selected: true });
        await expect(selected).toBeInViewport({ ratio: 1 });
      }
      await expect(dialog.getByRole("region").first()).toBeVisible();
      const footer = dialog.locator("footer");
      await expect(footer).toBeInViewport({ ratio: 1 });
    }
  });
}

test("mixed file and action rows align icons and names and keep shortcuts readable", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.find_files = () => [
      {
        path: "/dev/acme-api/src/main/kotlin/com/acme/navigation/FindAction.kt",
        relPath: "src/main/kotlin/com/acme/navigation/FindAction.kt",
        score: 100,
        indices: [],
      },
    ];
  });
  await doubleShift(page);
  const dialog = page.locator('[role="dialog"]:has(#se-query)');
  await dialog.getByRole("combobox").fill("Find Action");
  const file = dialog.getByRole("option", { name: /FindAction.kt/ });
  const action = dialog.locator('[class*="actionRow"]').filter({ hasText: "Find Action" }).first();
  await expect(file).toBeVisible();
  await expect(action).toBeVisible();
  const fileName = (await file.locator('[class*="main"] > [class*="name"]').boundingBox())!;
  const actionName = (await action.locator('[class*="main"] > [class*="name"]').boundingBox())!;
  expect(Math.abs(fileName.x - actionName.x)).toBeLessThan(1);
  const shortcut = action.locator('[class*="shortcut"]');
  await expect(shortcut).toBeVisible();
  const keys = (await shortcut.boundingBox())!;
  expect(keys.x).toBeGreaterThanOrEqual(actionName.x + actionName.width);
  expect(await shortcut.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("file and class results keep distinguishing folders visible in a narrow popup", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 520, height: 608 });
  await stubDesktop(page);
  const prefix = "packages/commerce-platform/customer-account-management/src/main/typescript/customer";
  const folders = ["renewal", "retention"];
  await page.evaluate(
    ({ prefix, folders }) => {
      const files = folders.map((folder, index) => {
        const relPath = `${prefix}/${folder}/OrderService.ts`;
        return {
          path: `/dev/acme-api/${relPath}`,
          relPath,
          score: 100 - index,
          indices: Array.from("OrderService", (_, i) => i),
        };
      });
      window.__ipc.handlers.find_files = () => files;
      window.__ipc.handlers.find_symbols = () =>
        files.map((file) => ({
          ...file,
          name: "OrderService",
          kind: "class",
          container: null,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
        }));
    },
    { prefix, folders },
  );

  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  const query = dialog.getByRole("combobox", { name: "Search query" });
  await query.fill("OrderService");
  for (const tab of ["Files", "Classes"]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    for (const folder of folders) {
      const path = `${prefix}/${folder}`;
      const result = dialog.getByRole("option", { name: new RegExp(folder) });
      const label = result.getByText(path, { exact: true });
      await expect(label).toBeVisible();
      expect(
        await label.evaluate((el, folder) => {
          const text = el.lastChild?.nodeType === Node.TEXT_NODE ? el.lastChild : el.lastElementChild?.firstChild;
          if (!text?.textContent?.endsWith(folder)) return false;
          const range = document.createRange();
          range.setStart(text, text.textContent.length - folder.length);
          range.setEnd(text, text.textContent.length);
          const label = el.getBoundingClientRect();
          const clip = text.parentElement!.getBoundingClientRect();
          const visible = range.getBoundingClientRect();
          return visible.left >= Math.max(label.left, clip.left) && visible.right <= Math.min(label.right, clip.right);
        }, folder),
      ).toBe(true);
      await expect(label).toHaveAttribute("title", path);
      if (tab === "Files") {
        const name = result.getByText("OrderService.ts", { exact: true });
        expect(
          await name.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().right <= el.getBoundingClientRect().right;
          }),
        ).toBe(true);
      }
    }
  }
});
