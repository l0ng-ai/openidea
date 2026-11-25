import { expect, test } from "./fixtures";

test("Inspections keeps the selected rule and its controls usable as the pane changes width", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 620, height: 720 });
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage("editor.inspections");
  });

  const search = dialog.getByRole("textbox", { name: "Search inspections" });
  await search.fill("typo");
  const tree = dialog.getByRole("tree", { name: "Inspections" });
  const typo = tree.getByRole("treeitem", { name: /Typo/ });
  await typo.click();
  const body = dialog.locator("[class*='pageBody']");
  await expect.poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  const resize = dialog.getByRole("separator", { name: "Resize inspection panes" });
  const details = dialog.getByRole("region", { name: "Inspection details" });
  await expect(resize).toHaveAttribute("aria-orientation", "horizontal");
  await expect(details.getByRole("heading", { name: "Typo" })).toBeVisible();
  const narrowTree = await tree.boundingBox();
  const narrowDetails = await details.boundingBox();
  expect(narrowDetails!.y).toBeGreaterThan(narrowTree!.y + narrowTree!.height);

  await expect(details.getByRole("separator", { name: "Resize inspection description" })).toHaveAttribute(
    "aria-orientation",
    "horizontal",
  );
  const severity = details.getByRole("button", { name: "Severity" });
  const severityBox = await severity.boundingBox();
  expect(severityBox!.y + severityBox!.height).toBeLessThan(narrowDetails!.y + narrowDetails!.height);
  await severity.click();
  await page.getByRole("option", { name: "Warning", exact: true }).click();
  const code = details.getByRole("checkbox", { name: "Process code" });
  await code.uncheck();
  await expect(severity).toHaveText("Warning");

  await page.setViewportSize({ width: 1040, height: 740 });
  await expect(resize).toHaveAttribute("aria-orientation", "vertical");
  const width = (await tree.boundingBox())!.width;
  await resize.press("ArrowRight");
  await expect.poll(async () => (await tree.boundingBox())!.width).toBeGreaterThan(width + 5);
  await expect(typo).toHaveAttribute("aria-selected", "true");
  await expect(severity).toHaveText("Warning");
  await expect(code).not.toBeChecked();
});
