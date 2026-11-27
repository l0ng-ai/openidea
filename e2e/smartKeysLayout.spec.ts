import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openSmartKeys(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Smart Keys");
  await dialog.getByRole("treeitem", { name: "Smart Keys", exact: true }).click();
  return dialog;
}

test("backspace and paste controls align below Enter options in Smart Keys", async ({ workbench: page }) => {
  const dialog = await openSmartKeys(page);
  const enter = dialog.getByRole("region", { name: "Enter", exact: true });
  const unindent = dialog.getByRole("button", { name: /^Unindent(?: on Backspace)?$/ });
  const paste = dialog.getByRole("button", { name: "Reformat on paste", exact: true });
  const escape = dialog.getByRole("checkbox", { name: "Escape text on paste in string literals", exact: true });

  for (const width of [1120, 520]) {
    await page.setViewportSize({ width, height: 760 });
    // The page scrolls once its options outgrow the dialog; the controls must be whole once in view.
    await paste.scrollIntoViewIfNeeded();
    await expect(unindent).toBeInViewport({ ratio: 0.98 });
    await expect(paste).toBeInViewport({ ratio: 0.98 });
    const enterBox = (await enter.boundingBox())!;
    const unindentBox = (await unindent.boundingBox())!;
    const pasteBox = (await paste.boundingBox())!;
    expect(unindentBox.y).toBeGreaterThan(enterBox.y + enterBox.height);
    expect(pasteBox.y).toBeGreaterThanOrEqual(unindentBox.y + unindentBox.height);
    expect(Math.abs(pasteBox.x - unindentBox.x)).toBeLessThan(1);
    expect((await escape.boundingBox())!.y).toBeGreaterThanOrEqual(pasteBox.y + pasteBox.height);
  }

  await paste.click();
  await expect(page.getByRole("option", { name: "Indent Each Line", exact: true })).toBeInViewport();
});

test("Smart Keys keeps backspace and paste preferences independent across Apply and Cancel", async ({
  workbench: page,
}) => {
  const setOption = async (label: string, option: string) => {
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };

  const dialog = await openSmartKeys(page);
  await setOption("Unindent on Backspace", "To nearest indent position");
  await setOption("Reformat on paste", "Indent Block");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const reopened = await openSmartKeys(page);
  await expect(reopened.getByRole("button", { name: "Unindent on Backspace", exact: true })).toHaveText(
    "To nearest indent position",
  );
  await expect(reopened.getByRole("button", { name: "Reformat on paste", exact: true })).toHaveText("Indent Block");
  await setOption("Reformat on paste", "None");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();

  const final = await openSmartKeys(page);
  await expect(final.getByRole("button", { name: "Unindent on Backspace", exact: true })).toHaveText(
    "To nearest indent position",
  );
  await expect(final.getByRole("button", { name: "Reformat on paste", exact: true })).toHaveText("Indent Block");
});
