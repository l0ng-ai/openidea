import { expect, openFromTree, test } from "./fixtures";

test("file tab actions are grouped around the tab the menu was opened from", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openFromTree(page, "build.gradle.kts");
  await openFromTree(page, "settings.gradle.kts");
  await openFromTree(page, "README.md");

  const tabs = page.getByRole("tablist", { name: "Editor tabs" });
  const target = tabs.getByRole("tab", { name: "settings.gradle.kts", exact: true });
  const active = tabs.getByRole("tab", { name: "README.md", exact: true });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await target.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(target).toHaveAttribute("aria-selected", "false");
  await expect(active).toHaveAttribute("aria-selected", "true");

  const groups = await menu.locator('[role="separator"], [role="menuitem"]').evaluateAll((elements) => {
    const groups: string[][] = [[]];
    for (const element of elements) {
      if (element.getAttribute("role") === "separator") groups.push([]);
      else groups.at(-1)!.push(element.querySelector('[class*="_label_"]')!.textContent!);
    }
    return groups;
  });
  expect(groups.slice(0, 4)).toEqual([
    [
      "Close",
      "Close Other Tabs",
      "Close All Tabs",
      "Close Unmodified Tabs",
      "Close Tabs to the Left",
      "Close Tabs to the Right",
    ],
    ["Copy Path/Reference…"],
    ["Split Right", "Split and Move Right", "Split Down", "Split and Move Down"],
    ["Pin Tab", "Open in New Window", "Configure Editor Tabs…"],
  ]);
  await expect(menu.locator("xpath=ancestor::*[@data-popup][1]")).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("menuitem", { name: "Close Tabs to the Left" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Close Tabs to the Right" })).toBeEnabled();
  await expect(menu.getByText("Copy Path/Reference…", { exact: true })).toHaveCSS("font-size", "13px");

  await menu.getByRole("menuitem", { name: "Split and Move Right" }).click();
  await expect(menu).toHaveCount(0);
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first().getByRole("tab", { name: "settings.gradle.kts", exact: true })).toHaveCount(0);
  await expect(tabs.last().getByRole("tab", { name: "settings.gradle.kts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await tabs.last().getByRole("tab", { name: "settings.gradle.kts", exact: true }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Move to Opposite Group" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Close Other Tabs" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Pin Tab", exact: true }).click();
  await tabs.last().getByRole("tab", { name: "settings.gradle.kts Pinned", exact: true }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Unpin Tab", exact: true })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Close All but Pinned" })).toBeEnabled();
});
