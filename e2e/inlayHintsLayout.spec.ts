import { expect, stubDesktop, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Inlay Hints");
  await dialog.getByRole("treeitem", { name: "Inlay Hints", exact: true }).click();
});

test("inlay hint categories and the preview fit at both settings widths", async ({ workbench: page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const categories = dialog.getByRole("listbox", { name: "Inlay hint categories" });
  const preview = dialog.getByRole("region", { name: "Inlay hint preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(": f64", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 760 });
  const wideList = (await categories.boundingBox())!;
  const widePreview = (await preview.boundingBox())!;
  expect(widePreview.x).toBeGreaterThan(wideList.x + wideList.width);
  expect(widePreview.y).toBeLessThan(wideList.y + wideList.height);

  await page.setViewportSize({ width: 520, height: 760 });
  await categories.press("End");
  await expect(categories.getByRole("option", { name: /^Other hints/ })).toHaveAttribute("aria-selected", "true");
  await expect(preview.getByText("= 300", { exact: true })).toBeVisible();
  const narrowList = (await categories.boundingBox())!;
  const narrowPreview = (await preview.boundingBox())!;
  expect(narrowPreview.y).toBeGreaterThan(narrowList.y + narrowList.height);
  await expect(preview).toBeInViewport({ ratio: 0.98 });
  expect(await preview.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("the hint preview follows staged settings and saves the selected category", async ({ workbench: page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  const categories = dialog.getByRole("listbox", { name: "Inlay hint categories" });
  const preview = dialog.getByRole("region", { name: "Inlay hint preview" });
  const master = dialog.getByRole("checkbox", { name: "Show inlay hints", exact: true });
  const parameters = dialog.getByRole("checkbox", { name: "Parameter names", exact: true });
  const parameterHint = preview.getByText("width:", { exact: true });

  await search.fill("Parameter names");
  await dialog.getByRole("treeitem", { name: "Inlay Hints", exact: true }).click();
  await expect(categories.getByRole("option", { name: "Parameter names", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(parameterHint).toBeVisible();
  await master.uncheck();
  await expect(parameters).toBeDisabled();
  await expect(parameterHint).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Show Code Vision", exact: true })).toBeEnabled();
  await master.check();
  await expect(parameterHint).toBeVisible();

  await parameters.uncheck();
  await expect(parameterHint).toHaveCount(0);
  await categories.press("Home");
  await expect(preview.getByText(": f64", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.keyboard.press("Meta+,");
  await search.fill("Parameter names");
  await dialog.getByRole("treeitem", { name: "Inlay Hints", exact: true }).click();
  await expect(parameters).not.toBeChecked();
  await expect(parameterHint).toHaveCount(0);
});

test("the hint preview respects the sample language's staged preference", async ({ workbench: page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.languages = () => [
      { id: "go", name: "Go" },
      { id: "rust", name: "Rust" },
    ];
  });
  await page.keyboard.press("Meta+,");
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Inlay Hints");
  await dialog.getByRole("treeitem", { name: "Inlay Hints", exact: true }).click();

  const preview = dialog.getByRole("region", { name: "Inlay hint preview" });
  const typeHint = preview.getByText(": f64", { exact: true });
  await expect(typeHint).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Rust", exact: true }).uncheck();
  await expect(typeHint).toHaveCount(0);
  await dialog.getByRole("listbox", { name: "Inlay hint categories" }).press("End");
  await expect(preview.getByText("= 300", { exact: true })).toBeVisible();
});
