import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openCompletionSettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("First letter only");
  await dialog.getByRole("treeitem", { name: "Code Completion", exact: true }).click();
  await search.clear();
  return dialog;
}

test("Code Completion puts both case-matching choices beside the checkbox and keeps them in view", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  const dialog = await openCompletionSettings(page);
  const matchCase = dialog.getByRole("checkbox", { name: "Match case:", exact: true });
  const choices = dialog.getByRole("radiogroup", { name: "Match case:", exact: true });
  const first = choices.getByRole("radio", { name: "First letter only", exact: true });
  const all = choices.getByRole("radio", { name: "All letters", exact: true });
  await expect(first).toBeChecked();
  await expect(all).not.toBeChecked();
  const matchBox = (await matchCase.boundingBox())!;
  const firstBox = (await first.boundingBox())!;
  const allBox = (await all.boundingBox())!;
  expect(Math.abs(matchBox.y - firstBox.y)).toBeLessThan(1);
  expect(Math.abs(firstBox.y - allBox.y)).toBeLessThan(1);
  expect(firstBox.x).toBeGreaterThan(matchBox.x + matchBox.width);
  expect(allBox.x).toBeGreaterThan(firstBox.x + firstBox.width);

  for (const width of [580, 520]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(matchCase).toBeInViewport({ ratio: 1 });
    await expect(first).toBeInViewport({ ratio: 1 });
    await expect(all).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByText("All letters", { exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test("Code Completion preserves case and popup delay preferences across Apply and Cancel", async ({
  workbench: page,
}) => {
  const dialog = await openCompletionSettings(page);
  const matchCase = dialog.getByRole("checkbox", { name: "Match case:", exact: true });
  const first = dialog.getByRole("radio", { name: "First letter only", exact: true });
  const all = dialog.getByRole("radio", { name: "All letters", exact: true });
  await matchCase.uncheck();
  await expect(first).toBeDisabled();
  await expect(all).toBeDisabled();
  await expect(first).toBeChecked();
  await matchCase.check();
  await first.press("ArrowRight");
  await expect(all).toBeChecked();

  const docs = dialog.getByRole("textbox", { name: "Show the documentation popup in", exact: true });
  const params = dialog.getByRole("textbox", { name: "Show the parameter info popup in", exact: true });
  await dialog.getByRole("checkbox", { name: "Show the documentation popup in", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Show the parameter info popup in", exact: true }).check();
  await docs.fill("750");
  await params.fill("1250");
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
  await cancel.click();

  await openCompletionSettings(page);
  await expect(all).toBeChecked();
  await expect(docs).toHaveValue("750");
  await expect(params).toHaveValue("1250");
  await matchCase.uncheck();
  await expect(all).toBeDisabled();
  await expect(all).toBeChecked();
  await cancel.click();
  await openCompletionSettings(page);
  await expect(matchCase).toBeChecked();
  await expect(all).toBeChecked();
});
