import { expect, openFromTree, test } from "./fixtures";

test("Reformat File aligns scope and option controls and supports arrow-key scope changes", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-line").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction("code.reformatDialog");
  });

  const dialog = page.getByRole("dialog", { name: /Reformat File/ });
  const scope = dialog.getByRole("group", { name: "Scope" });
  const selected = scope.getByRole("radio", { name: "Selected text" });
  await expect(selected).toBeChecked();
  await expect(scope.getByRole("radio").first()).toHaveAccessibleName("Selected text");
  await selected.press("ArrowDown");
  await expect(scope.getByRole("radio", { name: "Whole file" })).toBeChecked();

  const optimize = dialog.getByRole("group", { name: "Options" }).getByRole("checkbox", { name: "Optimize imports" });
  expect((await selected.boundingBox())!.x).toBeCloseTo((await optimize.boundingBox())!.x, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Reformat Code keeps long targets and the file mask usable in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 340, height: 460 });
  const target = "InternationalSettlementReconciliation".repeat(4);
  await page.evaluate(async (target) => {
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction("code.reformatFiles", { directories: [`/dev/acme-api/${target}`] });
  }, target);

  const dialog = page.getByRole("dialog", { name: "Reformat Code", exact: true });
  await expect(dialog.getByText(target, { exact: true })).toBeVisible();
  const body = dialog.locator("[data-dialog-body]");
  expect(await body.evaluate((el) => el.scrollWidth)).toBe(await body.evaluate((el) => el.clientWidth));

  await expect(
    dialog.getByRole("group", { name: "Options" }).getByRole("checkbox", { name: "Include subdirectories" }),
  ).toBeChecked();
  const filters = dialog.getByRole("group", { name: "Filters" });
  const mask = filters.getByRole("textbox", { name: "File mask" });
  await expect(mask).toBeDisabled();
  await filters.getByText("File mask:", { exact: true }).click();
  await mask.fill("*.java");
  await expect(mask).toHaveValue("*.java");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
