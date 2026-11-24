import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function editMacros(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    if (!(await (await import(/* @vite-ignore */ actions)).executeAction("macro.edit"))) throw Error("Edit Macros");
  });
}

test("Edit Macros keeps a balanced, resizable split for names and recorded steps", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const model = "/src/features/macros/model.ts";
    const { saveMacro } = await import(/* @vite-ignore */ model);
    saveMacro("Insert comment", [{ kind: "text", text: "Review this block" }]);
    saveMacro("Wrap selection", [
      { kind: "key", key: "Home" },
      { kind: "text", text: "beginProcessingCurrentSelectionImmediately();".repeat(6) },
      { kind: "key", key: "End" },
    ]);
  });
  await editMacros(page);

  const editor = page.getByRole("dialog", { name: "Edit Macros", exact: true });
  const macros = editor.getByRole("listbox", { name: "Macros" });
  const steps = editor.getByRole("list", { name: "Recorded steps" });
  const options = editor.getByRole("toolbar", { name: "Macros" });
  const divider = editor.getByRole("separator", { name: "Macros" });
  const [initial, stepsWidth] = await editor.evaluate((dialog) => [
    dialog.querySelector('[role="listbox"]')!.getBoundingClientRect().width,
    dialog.querySelector("ol")!.getBoundingClientRect().width,
  ]);
  expect(Math.abs(initial - stepsWidth)).toBeLessThanOrEqual(1);
  await expect(macros).toBeFocused();
  expect((await steps.boundingBox())!.height).toBeGreaterThan(260);
  expect((await options.boundingBox())!.y).toBeLessThan((await macros.boundingBox())!.y);

  await macros.getByRole("option", { name: "Wrap selection" }).click();
  await expect(steps.getByText("Press Home")).toBeVisible();
  await divider.press("ArrowRight");
  await expect.poll(async () => (await macros.boundingBox())!.width).toBeGreaterThan(initial + 5);
  const resized = (await macros.boundingBox())!.width;
  await editor.locator("[data-dialog-footer]").getByRole("button", { name: "Close" }).click();
  await editMacros(page);
  await expect.poll(async () => (await macros.boundingBox())!.width).toBeCloseTo(resized, 0);

  await page.setViewportSize({ width: 400, height: 620 });
  await macros.getByRole("option", { name: "Wrap selection" }).click();
  expect(await steps.evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(1);
  await options.getByRole("button", { name: "Rename Macro" }).click();
  const rename = page.getByRole("dialog", { name: "Rename Macro", exact: true });
  await rename.getByRole("textbox").fill("Wrap text");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(macros.getByRole("option", { name: "Wrap text" })).toBeVisible();
  await expect(steps.getByText("Press Home")).toBeVisible();
});
