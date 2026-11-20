import { expect, test } from "./fixtures";

test("Plugin management keeps the selected details reachable when Settings narrows", async ({ workbench: page }) => {
  const name = "ReconciliationTimelineInspectorEnterprise";
  const notes = "SettlementTimeline".repeat(18);
  await page.evaluate(
    async ({ name, notes }) => {
      const path = "/src/features/plugins/backend.ts";
      const { createMemoryPluginsBackend, setPluginsBackend } = await import(/* @vite-ignore */ path);
      const { plugins } = await createMemoryPluginsBackend().list();
      const longPlugin = { ...plugins[0], id: "settlement-inspector", name, changeNotes: notes };
      setPluginsBackend(createMemoryPluginsBackend([longPlugin, ...plugins.slice(1)]));
    },
    { name, notes },
  );

  await page.setViewportSize({ width: 1080, height: 760 });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Plugins", exact: true }).click();
  await settings.getByRole("tab", { name: "Installed", exact: true }).click();

  const filter = settings.getByRole("textbox", { name: "Filter plugins" });
  const list = settings.getByRole("list", { name: "Installed plugins" });
  const details = settings.getByLabel(`${name} details`);
  const heading = details.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible();

  const filterBox = (await filter.boundingBox())!;
  const headingBox = (await heading.boundingBox())!;
  expect(headingBox.x).toBeGreaterThan(filterBox.x + filterBox.width);

  await page.setViewportSize({ width: 520, height: 760 });
  const body = settings.locator("[class*='pageBody']");
  await expect.poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const divider = settings.getByRole("separator", { name: "Resize plugin panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const sources = settings.getByRole("tablist", { name: "Plugin sources" });
  await expect(sources.getByRole("tab", { name: "Marketplace" })).toBeVisible();
  await expect(sources.getByRole("tab", { name: "Installed" })).toBeVisible();
  expect(await sources.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  const before = (await divider.boundingBox())!.y;
  await divider.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeGreaterThan(before);
  await expect(details.getByRole("button", { name: "Disable", exact: true })).toBeVisible();

  await details.getByRole("tab", { name: "What's New" }).click();
  await expect(details.getByText(notes, { exact: true })).toBeVisible();
  expect(await details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await filter.click();
  await expect(filter).toBeFocused();
  await filter.pressSequentially("Harbor");
  await list.getByRole("button", { name: /Harbor Night Theme/ }).click();
  await expect(settings.getByRole("heading", { name: "Harbor Night Theme", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1080, height: 760 });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(filter).toHaveValue("Harbor");
  await expect(settings.getByRole("heading", { name: "Harbor Night Theme", exact: true })).toBeVisible();
});
