import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openRefactorList(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/editor/lsp/popupStore.ts";
    const { openPopup } = await import(/* @vite-ignore */ path);
    const run = (action: string) => () => {
      document.body.dataset.selectedRefactoring = action;
    };
    openPopup({
      kind: "list",
      title: "Refactor This",
      anchor: { x: 300, y: 140 },
      compact: true,
      numbered: true,
      items: [
        { id: "rename", label: "Rename…", shortcut: "Shift+F6", run: run("rename") },
        {
          id: "extractVariable",
          label: "Introduce Variable…",
          shortcut: "Ctrl+Alt+V",
          section: { id: "extract", label: "Extract/Introduce" },
          run: run("extractVariable"),
        },
        { id: "inline", label: "Inline…", section: { id: "inline" }, run: run("inline") },
      ],
    });
  });
}

test("the compact Refactor This list groups actions without numbering or selecting its captions", async ({
  workbench: page,
}) => {
  await openRefactorList(page);
  const popup = page.getByRole("dialog", { name: "Refactor This", exact: true });
  const group = popup.getByText("Extract/Introduce", { exact: true });
  await expect(group).toBeVisible();
  expect((await popup.boundingBox())!.width).toBeLessThan(360);
  await expect(popup.getByRole("option")).toHaveCount(3);
  const introduce = popup.getByRole("option", { name: /Introduce Variable/ });
  await expect(introduce.getByText("2", { exact: true })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await expect(introduce).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("2");
  await expect(popup).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-selected-refactoring", "extractVariable");
});

test("filtering keeps captions only for groups with a matching action", async ({ workbench: page }) => {
  await openRefactorList(page);
  const popup = page.getByRole("dialog", { name: "Refactor This", exact: true });
  const list = popup.getByRole("listbox");
  const group = popup.getByText("Extract/Introduce", { exact: true });
  await expect(list).toBeFocused();
  await expect(group).toBeVisible();

  await page.keyboard.type("variable");
  await expect(group).toBeVisible();
  await expect(popup.getByRole("option")).toHaveCount(1);
  await expect(popup.getByRole("option")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-selected-refactoring", "extractVariable");

  await openRefactorList(page);
  await expect(list).toBeFocused();
  await page.keyboard.type("rename");
  await expect(group).toBeHidden();
  await expect(popup.getByRole("option", { name: /Rename/ })).toHaveAttribute("aria-selected", "true");
});
