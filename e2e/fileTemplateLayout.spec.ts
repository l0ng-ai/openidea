import { expect, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage("editor.fileTemplates");
  });
});

test("file template fields and editors fit in narrow settings", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 520, height: 760 });
  const tabs = page.getByRole("tablist", { name: "Template kinds" });
  const name = page.getByRole("textbox", { name: "Template name" });
  const extension = page.getByRole("textbox", { name: "Extension" });
  const style = page.getByRole("button", { name: "File name style" });
  const body = page.getByRole("textbox", { name: "Template body", exact: true });

  await expect(body).toBeInViewport({ ratio: 0.98 });
  expect((await body.boundingBox())!.width).toBeGreaterThan(150);
  await expect(extension).toBeInViewport({ ratio: 0.98 });
  await expect(style).toBeInViewport({ ratio: 0.98 });
  expect((await extension.boundingBox())!.y).toBeGreaterThan((await name.boundingBox())!.y);
  expect((await style.boundingBox())!.y).toBeGreaterThan((await extension.boundingBox())!.y);
  await style.click();
  await expect(page.getByRole("option", { name: "PascalCase" })).toBeVisible();
  await page.keyboard.press("Escape");

  for (const [tab, editorName] of [
    ["Includes", "Include body"],
    ["Code", "Code template body"],
  ]) {
    await tabs.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.getByRole("textbox", { name: editorName, exact: true })).toBeInViewport({ ratio: 0.98 });
  }
});

test("file template tabs share a remembered, keyboard-adjustable divider", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  const tabs = page.getByRole("tablist", { name: "Template kinds" });
  const name = page.getByRole("textbox", { name: "Template name" });
  const extension = page.getByRole("textbox", { name: "Extension" });
  const divider = page.getByRole("separator", { name: "Resize file template panes" });
  const width = async (listName: string) =>
    (await page.getByRole("listbox", { name: listName, exact: true }).boundingBox())!.width;

  await expect(divider).toBeVisible();
  expect((await extension.boundingBox())!.y).toBe((await name.boundingBox())!.y);
  const initial = await width("File templates");
  await divider.press("ArrowRight");
  await expect.poll(() => width("File templates")).toBeGreaterThan(initial + 10);
  const resized = await width("File templates");

  await tabs.getByRole("tab", { name: "Files", exact: true }).press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Includes", exact: true })).toBeFocused();
  await expect.poll(() => width("Includes")).toBeCloseTo(resized, 0);
  await page.getByRole("button", { name: "Add Include" }).click();
  const include = page.getByRole("textbox", { name: "Include body" });
  await include.fill("// Shared header");

  await tabs.getByRole("tab", { name: "Code", exact: true }).click();
  await expect.poll(() => width("Code templates")).toBeCloseTo(resized, 0);
  await tabs.getByRole("tab", { name: "Includes", exact: true }).click();
  await page.getByRole("option", { name: "New Include", exact: true }).click();
  await expect(include).toHaveValue("// Shared header");
});
