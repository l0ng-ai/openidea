import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function show(page: Page, action: string) {
  await page.evaluate(async (action) => {
    const actions = "/src/platform/actions.ts";
    if (!(await (await import(/* @vite-ignore */ actions)).executeAction(action))) throw Error(action);
  }, action);
}

test("analysis scope fields align with their radio choices and retain their values", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const search = "/src/platform/search.ts";
    (await import(/* @vite-ignore */ search)).saveCustomScopes([
      { name: "Frontend", pattern: "file:src//*" },
      { name: "Tests", pattern: "file:tests//*" },
    ]);
  });
  await show(page, "analyze.inspectCode");
  const dialog = page.getByRole("dialog", { name: "Specify Inspection Scope" });
  const scope = dialog.getByRole("group", { name: "Scope" });
  const directory = scope.getByRole("textbox", { name: "Directory" });
  const custom = scope.getByRole("button", { name: "Custom scope", exact: true });
  const radio = scope.getByRole("radio", { name: "Module or directory" });
  const label = scope.getByText("Module or directory", { exact: true });

  await radio.check();
  const path = (await directory.boundingBox())!;
  const choice = (await label.boundingBox())!;
  expect(path.y + path.height / 2).toBeCloseTo(choice.y + choice.height / 2, 0);
  await directory.fill("/dev/acme-api/src");
  await expect(custom).toBeDisabled();
  await scope.getByRole("radio", { name: "Custom scope", exact: true }).check();
  await expect(directory).toBeDisabled();
  expect((await custom.boundingBox())!.x).toBeCloseTo(path.x, 0);
  await custom.click();
  await page.getByRole("option", { name: /^Tests/ }).click();
  await expect(custom).toContainText("Tests");

  await radio.check();
  await expect(directory).toHaveValue("/dev/acme-api/src");
  await scope.getByRole("radio", { name: "Custom scope", exact: true }).check();
  await expect(custom).toContainText("Tests");
  await page.setViewportSize({ width: 400, height: 640 });
  const stacked = (await directory.boundingBox())!;
  const customBox = (await custom.boundingBox())!;
  const radioBox = (await label.boundingBox())!;
  const next = (await scope.getByText("Current file", { exact: true }).boundingBox())!;
  expect(stacked.y).toBeGreaterThan(radioBox.y + radioBox.height);
  expect(stacked.y + stacked.height).toBeLessThan(next.y);
  expect(stacked.x).toBeCloseTo(customBox.x, 0);
  expect(await scope.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

for (const [action, title] of [
  ["code.cleanup", "Run Code Cleanup"],
  ["analyze.locateDuplicates", "Locate Duplicates"],
  ["find.structural", "Structural Search"],
  ["find.replaceStructural", "Structural Replace"],
] as const) {
  test(`${title} keeps directory options with their scope choice`, async ({ workbench: page }) => {
    await show(page, action);
    const dialog = page.getByRole("dialog", { name: title });
    const scope = dialog.getByRole("group", { name: "Scope" });
    const directory = scope.getByRole("textbox", { name: "Directory" });
    await expect(directory).toBeDisabled();
    await scope.getByRole("radio", { name: "Module or directory" }).check();
    await expect(directory).toBeEnabled();
    await expect(scope.getByRole("button", { name: "Browse…" })).toBeEnabled();
  });
}
