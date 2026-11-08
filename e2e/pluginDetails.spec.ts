import { expect, test } from "@playwright/test";

test.use({ video: "on" });

for (const kind of ["tree", "list"]) {
  test(`${kind} detail follows selection, refresh and removal and remembers a dragged divider`, async ({ page }) => {
    await page.goto(`/e2e/pluginDetails.html?kind=${kind}`);
    await page.getByText("alpha", { exact: true }).click();
    await expect(page.locator("#root").getByRole("document")).toHaveText(`${kind}: alpha\nRevision 0`);
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("Selected alpha", { exact: true })).toBeVisible();
    await page.getByText("beta", { exact: true }).click();
    await expect(page.locator("#root").getByRole("document")).toContainText(`${kind}: beta`);
    const handle = page.getByRole("separator");
    const before = await handle.boundingBox();
    expect(before).not.toBeNull();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + 50);
    await page.mouse.down();
    await page.mouse.move(before!.x + 150, before!.y + 50, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await handle.boundingBox())!.x).toBeGreaterThan(before!.x + 100);
    const dragged = (await handle.boundingBox())!.x;
    await page.getByRole("button", { name: "Toggle view" }).click();
    await page.getByRole("button", { name: "Toggle view" }).click();
    await expect(handle).toBeVisible();
    await expect.poll(async () => Math.abs((await handle.boundingBox())!.x - dragged)).toBeLessThan(2);
    await page.getByText("alpha", { exact: true }).click();
    await page.getByRole("button", { name: "Refresh details" }).click();
    await expect(page.locator("#root").getByRole("document")).toContainText("Revision 1");
    await page.getByRole("button", { name: "Switch remote host" }).click();
    await expect(page.getByLabel("Remote host")).toHaveText("two");
    await expect(page.getByText("Select an item to view details")).toBeVisible();
    await expect(page.locator("#root").getByRole("document")).toHaveCount(0);
    await page.getByText("alpha", { exact: true }).click();
    await expect(page.locator("#root").getByRole("document")).toContainText(`${kind}: alpha`);
    await page.getByRole("button", { name: "Remove alpha" }).click();
    await expect(page.getByText("Select an item to view details")).toBeVisible();
    await expect(page.locator("#root").getByRole("document")).toHaveCount(0);
    await page.reload();
    await expect(handle).toBeVisible();
    await expect.poll(async () => Math.abs((await handle.boundingBox())!.x - dragged)).toBeLessThan(2);
  });
}
