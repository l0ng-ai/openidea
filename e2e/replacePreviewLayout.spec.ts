import { expect, openFromTree, test } from "./fixtures";

test("regex replacement previews the expanded result beside the selected match", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  const editor = await openFromTree(page, "build.gradle.kts");
  const content = editor.locator(".cm-content");
  await content.press("Meta+a");
  await page.keyboard.insertText("ledger:USD:104\nledger:EUR:82\nstatus:posted\n");
  await content.press("Meta+r");
  const bar = page.getByRole("search", { name: "Replace in file" });
  const find = bar.getByRole("textbox", { name: "Find" });
  const replace = bar.getByRole("textbox", { name: "Replace" });
  await bar.getByRole("button", { name: "Regex" }).click();
  await find.fill("ledger:([A-Z]{3}):(\\d+)");
  await replace.fill("$2 $1");

  const preview = page.getByRole("tooltip", { name: "Replacement preview" });
  await expect(preview).toHaveText("104 USD");
  await expect(preview).toBeInViewport({ ratio: 1 });
  const current = editor.locator(".cm-openidea-findMatch-current").first();
  const match = (await current.boundingBox())!;
  const balloon = (await preview.boundingBox())!;
  expect(balloon.y).toBeGreaterThanOrEqual(match.y + match.height);
  expect(balloon.y - match.y - match.height).toBeLessThan(20);
  await expect(replace).toBeFocused();
  await expect(preview.locator("code")).toHaveCSS("font-size", "13px");

  await page.setViewportSize({ width: 630, height: 510 });
  await replace.fill("$2 ".repeat(110) + "$1");
  await expect(preview).toContainText("104 104");
  await expect(preview).toBeInViewport({ ratio: 1 });
  const narrowPane = (await editor.boundingBox())!;
  const narrowBalloon = (await preview.boundingBox())!;
  expect(narrowBalloon.x + narrowBalloon.width).toBeLessThanOrEqual(narrowPane.x + narrowPane.width + 1);

  await replace.fill("$2 $1");
  await find.press("Enter");
  await expect(preview).toHaveText("82 EUR");
  await expect(find).toBeFocused();
  await expect(content).toContainText("ledger:EUR:82");
  await replace.press("Enter");
  await expect(content).toContainText("82 EUR");
  await expect(content).not.toContainText("ledger:EUR:82");
  await expect(preview).toHaveText("104 USD");
  await find.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(bar).toHaveCount(0);
});
