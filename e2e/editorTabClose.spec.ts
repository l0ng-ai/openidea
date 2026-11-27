import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

async function setTabs(page: Page, tabs: Record<string, unknown>) {
  await page.evaluate(async (tabs) => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: { ...settings, editor: { ...settings?.editor, tabs: { ...settings?.editor?.tabs, ...tabs } } },
    });
  }, tabs);
}

const box = async (locator: Locator) => (await locator.boundingBox())!;
const closeOf = (tab: Locator) => tab.locator("..").getByRole("button", { name: "Close Tab", exact: true });

test("a close button on the right keeps a narrow slot on every tab", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openFromTree(page, "build.gradle.kts");
  const strip = page.getByRole("tablist", { name: "Editor tabs" });
  const idle = strip.getByRole("tab", { name: "README.md" });
  const label = await box(idle.locator(":scope > span"));
  const idleTab = await box(idle.locator(".."));
  expect(idleTab.x + idleTab.width - (label.x + label.width)).toBeCloseTo(18, 0);

  const selected = strip.getByRole("tab", { name: "build.gradle.kts" });
  const close = await box(closeOf(selected));
  const tab = await box(selected.locator(".."));
  const text = await box(selected.locator(":scope > span"));
  expect(close.x).toBeGreaterThanOrEqual(text.x + text.width - 0.5);
  expect(close.x + close.width).toBeLessThanOrEqual(tab.x + tab.width + 0.5);
  expect(tab.x - (idleTab.x + idleTab.width)).toBeCloseTo(4, 0);
});

for (const closeButtonPosition of ["right", "left"]) {
  test(`a dragged tab's ghost keeps the tab's layout, close button ${closeButtonPosition}`, async ({
    workbench: page,
  }) => {
    await openFromTree(page, "README.md");
    await openFromTree(page, "build.gradle.kts");
    await setTabs(page, { closeButtonPosition });
    const selected = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "build.gradle.kts" });
    const tab = await box(selected.locator(".."));
    const close = await box(closeOf(selected));
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await page.mouse.down();
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 40, { steps: 4 });
    const ghost = page.locator('[aria-hidden="true"]:has([data-tab-close])');
    const copy = await box(ghost);
    const copyClose = await box(ghost.locator("[data-tab-close] button"));
    expect(copy.width).toBeCloseTo(tab.width, 0);
    expect(copyClose.x - copy.x).toBeCloseTo(close.x - tab.x, 0);
    expect(copyClose.x + copyClose.width).toBeLessThanOrEqual(copy.x + copy.width + 0.5);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
  });
}

test("a close button on the left keeps a narrow slot before the icon", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openFromTree(page, "build.gradle.kts");
  await setTabs(page, { closeButtonPosition: "left" });
  const strip = page.getByRole("tablist", { name: "Editor tabs" });

  // The selected and the hovered tab show their button in an 18px slot before the icon, which stays visible.
  const selected = strip.getByRole("tab", { name: "build.gradle.kts" });
  const other = strip.getByRole("tab", { name: "README.md" });
  await other.hover();
  for (const tab of [selected, other]) {
    const icon = tab.locator(":scope > :first-child");
    await expect(icon).toHaveCSS("opacity", "1");
    await expect(closeOf(tab)).toHaveCSS("opacity", "1");
    const slot = await box(tab.locator(".."));
    const close = await box(closeOf(tab));
    const glyph = await box(icon);
    const label = await box(tab.locator(":scope > span"));
    expect(close.x + close.width).toBeLessThanOrEqual(glyph.x + 0.5);
    expect(glyph.x - slot.x).toBeCloseTo(18, 0);
    expect(slot.x + slot.width - (label.x + label.width)).toBeCloseTo(8, 0);
  }

  // Without file icons the close button keeps its own place before the label.
  await setTabs(page, { showFileIcon: false });
  await expect(selected.locator("svg, img")).toHaveCount(0);
  const label = await box(selected.locator(":scope > span"));
  const slot = await box(closeOf(selected));
  expect(slot.x + slot.width).toBeLessThanOrEqual(label.x + 0.5);
});

test("a pinned editor tab uses the close slot and can be unpinned from it", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openFromTree(page, "build.gradle.kts");
  const strip = page.getByRole("tablist", { name: "Editor tabs" });
  const unpinned = strip.getByRole("tab", { name: "build.gradle.kts", exact: true });
  const pinned = strip.getByRole("tab", { name: "build.gradle.kts Pinned", exact: true });
  const menu = page.getByRole("menu", { name: "Context menu" });
  const pin = async () => {
    await unpinned.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Pin Tab", exact: true }).click();
  };
  await pin();
  const unpin = pinned.locator("..").getByRole("button", { name: "Unpin Tab", exact: true });

  for (const closeButtonPosition of ["right", "left"]) {
    await setTabs(page, { closeButtonPosition });
    await expect(closeOf(pinned)).toHaveCount(0);
    const tab = await box(pinned.locator(".."));
    const action = await box(unpin);
    const label = await box(pinned.locator(":scope > span"));
    const inset = closeButtonPosition === "left" ? action.x - tab.x : tab.x + tab.width - action.x - action.width;
    expect(inset).toBeCloseTo(2, 0);
    expect(action.width).toBeCloseTo(16, 0);
    if (closeButtonPosition === "left") expect(action.x + action.width).toBeLessThanOrEqual(label.x);
    else expect(action.x).toBeGreaterThanOrEqual(label.x + label.width);
  }

  await setTabs(page, { showCloseButton: false });
  await unpin.click();
  await expect(unpinned).toHaveAttribute("aria-selected", "true");
  await expect(closeOf(unpinned)).toHaveCount(0);

  await pin();
  await pinned.click({ button: "middle" });
  await expect(pinned).toHaveCount(0);
});
