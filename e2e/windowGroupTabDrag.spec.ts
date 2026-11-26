import { expect, test } from "./fixtures";

test("dragging a project tab shows a ghost and accent insertion line, and reorders on drop", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const windowGroups = "/src/platform/windowGroups.ts";
    const { useWindowGroup } = await import(/* @vite-ignore */ windowGroups);
    useWindowGroup.setState({
      tabs: [
        { label: "first", name: "idea", root: "/first", current: true },
        { label: "second", name: "kalopilot-assistant-stack", root: "/second", current: false },
        { label: "third", name: "kalopilot", root: "/third", current: false },
      ],
    });
  });

  const tablist = page.locator('[data-window-group] [role="tablist"]');
  const first = tablist.locator('[data-project-tab="first"]');
  const second = tablist.locator('[data-project-tab="second"]');
  const third = tablist.locator('[data-project-tab="third"]');
  await expect(third).toBeVisible();

  const firstBox = (await first.boundingBox())!;
  const secondBox = (await second.boundingBox())!;
  const thirdBox = (await third.boundingBox())!;
  const startY = firstBox.y + firstBox.height / 2;

  await page.mouse.move(firstBox.x + firstBox.width / 2, startY);
  await page.mouse.down();

  // Past the middle tab's centre: source dims, ghost follows pointer, insertion line marks before third tab.
  await page.mouse.move(secondBox.x + secondBox.width * 0.7, startY, { steps: 8 });
  await expect(tablist).toHaveAttribute("data-dragging", "");
  expect(Number(await first.evaluate((el) => getComputedStyle(el).opacity))).toBeCloseTo(0.4, 1);
  const ghost = page.locator('body > div > [aria-hidden="true"][data-project-tab="first"]');
  await expect(ghost).toBeVisible();
  expect(await third.evaluate((el) => getComputedStyle(el, "::before").width)).toBe("2px");

  // Past the last tab's centre: insertion line moves to the trailing edge.
  await page.mouse.move(thirdBox.x + thirdBox.width * 0.75, startY, { steps: 6 });
  expect(await third.evaluate((el) => getComputedStyle(el, "::after").width)).toBe("2px");

  await page.mouse.up();
  await expect(tablist).not.toHaveAttribute("data-dragging");
  await expect(ghost).toHaveCount(0);

  const order = await tablist
    .locator("[data-project-tab]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-project-tab")));
  expect(order).toEqual(["second", "third", "first"]);
  await expect(first.locator('[role="tab"]')).toHaveAttribute("aria-selected", "true");

  // Pressing Escape cancels without reordering.
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 20, box.y + box.height / 2, { steps: 6 });
  await expect(tablist).toHaveAttribute("data-dragging", "");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(tablist).not.toHaveAttribute("data-dragging");

  const orderAfterCancel = await tablist
    .locator("[data-project-tab]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-project-tab")));
  expect(orderAfterCancel).toEqual(["second", "third", "first"]);
});
