import { expect, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Notifications");
  await dialog.getByRole("treeitem", { name: "Notifications", exact: true }).click();
});

test("notification group controls stay inside narrow settings", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 520, height: 760 });
  const groups = page.getByRole("region", { name: "Groups", exact: true });
  const popup = groups.getByRole("button", { name: "System Messages popup type" });
  await expect(popup).toBeInViewport({ ratio: 0.98 });
  expect(await groups.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  const list = groups.getByRole("listbox", { name: "Notification groups" });
  const controls = groups.getByRole("region", { name: "System Messages", exact: true });
  const listBounds = (await list.boundingBox())!;
  expect((await controls.boundingBox())!.y).toBeGreaterThanOrEqual(listBounds.y + listBounds.height);
  await popup.click();
  await expect(page.getByRole("option", { name: "Sticky balloon", exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");

  await list.press("End");
  const lastGroup = list.getByRole("option", { name: "Distraction Free Mode", exact: true });
  await expect(lastGroup).toHaveAttribute("aria-selected", "true");
  await expect(lastGroup).toBeInViewport({ ratio: 0.98 });
  await list.press("Home");

  await page.setViewportSize({ width: 1100, height: 760 });
  const wideList = (await list.boundingBox())!;
  const wideControls = (await controls.boundingBox())!;
  expect(wideControls.x).toBeGreaterThan(wideList.x + wideList.width);
  expect(wideControls.y).toBeLessThan(wideList.y + wideList.height);
});

test("notification groups follow settings search and keep edits per group", async ({ workbench: page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  const list = dialog.getByRole("listbox", { name: "Notification groups" });
  const systemPopup = dialog.getByRole("button", { name: "System Messages popup type" });
  const versionControlPopup = dialog.getByRole("button", { name: "Version Control popup type" });
  const versionControlLog = dialog.getByRole("checkbox", { name: "Show Version Control in tool window" });

  await list.press("ArrowDown");
  await expect(list.getByRole("option", { name: "Language Servers" })).toHaveAttribute("aria-selected", "true");
  await search.fill("Version Control");
  await dialog.getByRole("treeitem", { name: "Notifications", exact: true }).click();
  await expect(list.getByRole("option", { name: "Version Control", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await versionControlPopup.click();
  await page.getByRole("option", { name: "No popup", exact: true }).click();
  await versionControlLog.uncheck();

  await list.press("Home");
  await expect(systemPopup).toHaveText("Balloon");
  await expect(dialog.getByRole("checkbox", { name: "Show System Messages in tool window" })).toBeChecked();
  await list.getByRole("option", { name: "Version Control", exact: true }).click();
  await expect(versionControlPopup).toHaveText("No popup");
  await expect(versionControlLog).not.toBeChecked();

  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await search.fill("Version Control");
  await dialog.getByRole("treeitem", { name: "Notifications", exact: true }).click();
  await expect(versionControlPopup).toHaveText("No popup");
  await expect(versionControlLog).not.toBeChecked();
});
