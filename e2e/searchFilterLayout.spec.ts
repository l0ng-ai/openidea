import { doubleShift, expect, stubDesktop, test } from "./fixtures";

test("search filters keep bulk controls visible when the list scrolls and update results", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 680, height: 490 });
  await stubDesktop(page);
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    h.languages = () => [
      { id: "typescript", name: "TypeScript", extensions: ["ts"] },
      { id: "kotlin", name: "Kotlin", extensions: ["kt"] },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `fixture-${i}`,
        name: `Language ${String(i).padStart(2, "0")}`,
        extensions: [`lang${i}`],
      })),
      { id: "long", name: "Zoned Settlement Reconciliation Configuration Language", extensions: ["zrc"] },
    ];
    h.find_files = () =>
      ["ts", "kt"].map((ext) => ({
        path: `/dev/acme-api/invoice.${ext}`,
        relPath: `invoice.${ext}`,
        score: 100,
        indices: [],
      }));
    h.find_dirs = () => [];
  });
  await doubleShift(page);
  const search = page.locator('[role="dialog"]:has(#se-query)');
  const query = search.getByRole("combobox", { name: "Search query" });
  await search.getByRole("tab", { name: "Files", exact: true }).click();
  await query.fill("invoice");
  const ts = search.getByRole("option", { name: /invoice\.ts/ });
  const kt = search.getByRole("option", { name: /invoice\.kt/ });
  await expect(ts).toBeVisible();
  await expect(kt).toBeVisible();
  const trigger = search.getByRole("button", { name: "Filter", exact: true });
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Filter", exact: true });
  const types = popup.getByRole("group", { name: "File Types" });
  const all = types.getByRole("button", { name: "All", exact: true });
  const none = types.getByRole("button", { name: "None", exact: true });
  const invert = types.getByRole("button", { name: "Invert", exact: true });
  await expect(invert).toBeInViewport({ ratio: 1 });
  await expect(popup).toBeInViewport({ ratio: 1 });
  const footer = (await invert.boundingBox())!;
  const kotlin = types.getByRole("checkbox", { name: "Kotlin", exact: true });
  await expect(kotlin).toBeChecked();
  await expect(types.locator("label", { hasText: "Kotlin" }).locator('svg[width="16"]')).toBeVisible();
  await kotlin.focus();
  await page.keyboard.press("End");
  const long = types.getByRole("checkbox", { name: /Zoned Settlement/ });
  await expect(long).toBeFocused();
  await expect(long).toBeInViewport({ ratio: 1 });
  expect((await invert.boundingBox())!.y).toBeCloseTo(footer.y, 0);
  const label = types.getByText("Zoned Settlement Reconciliation Configuration Language", { exact: true });
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await none.click();
  await expect(ts).toBeHidden();
  await expect(kt).toBeHidden();
  await kotlin.focus();
  await page.keyboard.press("Space");
  await expect(kt).toBeVisible();
  await expect(ts).toBeHidden();
  await invert.click();
  await expect(kt).toBeHidden();
  await expect(ts).toBeVisible();
  await all.click();
  await expect(kt).toBeVisible();
  await expect(ts).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(query).toBeFocused();

  await search.getByRole("tab", { name: "Classes", exact: true }).click();
  await trigger.click();
  const kinds = popup.getByRole("group", { name: "Kinds", exact: true });
  const languages = popup.getByRole("group", { name: "Languages", exact: true });
  await expect(kinds.getByRole("button", { name: "Invert", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(languages.getByRole("button", { name: "Invert", exact: true })).toBeInViewport({ ratio: 1 });
  await kinds.getByRole("button", { name: "None", exact: true }).click();
  await expect(kinds.getByRole("checkbox").first()).not.toBeChecked();
  await expect(languages.getByRole("checkbox", { name: "Kotlin", exact: true })).toBeChecked();
});
