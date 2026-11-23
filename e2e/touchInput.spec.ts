import { expect, test } from "./fixtures";

test.use({ hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 } });

test("a touch screen gets finger-sized rows and a long press opens the context menu", async ({ workbench: page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-form-factor", "tablet");
  await expect(page.locator("html")).toHaveAttribute("data-touch", "");

  const row = page.getByRole("treeitem", { name: /acme-api/ });
  expect((await row.boundingBox())?.height).toBe(36);

  const box = (await row.boundingBox())!;
  const point = { x: Math.round(box.x + 40), y: Math.round(box.y + box.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  // One menu, still open after the finger lifts.
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Copy Path/Reference…" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("touch-long-press.png"), animations: "disabled" });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows one page at a time above a bottom bar of tool windows", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByRole("navigation", { name: "Tool Windows" });
    await expect(bar.getByRole("button")).toHaveText(["Agents", "Editor", "Git", "Database", "More"]);
    await expect(page.getByRole("tree", { name: "Project" })).toHaveCount(0);

    await bar.getByRole("button", { name: "Git" }).tap();
    await expect(page.getByRole("region", { name: "Commit", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Log" }).tap();
    await expect(page.getByRole("region", { name: "Git", exact: true })).toBeVisible();

    await bar.getByRole("button", { name: "More" }).tap();
    await page.getByRole("button", { name: "Project", exact: true }).tap();
    const project = page.getByRole("region", { name: "Project", exact: true });
    await expect(project.getByRole("tree", { name: "Project" })).toBeVisible();
    await expect(project.getByRole("button", { name: "Hide" })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "More" })).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: test.info().outputPath("phone-project.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Back" }).tap();
    await expect(page.getByRole("heading", { name: "Tool Windows" })).toBeVisible();
  });
});
