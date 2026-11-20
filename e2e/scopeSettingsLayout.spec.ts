import { expect, test } from "./fixtures";

test("keeps scope navigation and editing usable as Settings narrows", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1180, height: 770 });
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const longName = "Shared API and generated deployment artifacts for regional settlement services";
  const longPattern = "file:services/settlement//*.ts && !file:*.test.ts";
  await page.evaluate(
    async ({ longName, longPattern }) => {
      const path = "/src/features/settings/model/staging.ts";
      const { selectPage, stage } = await import(/* @vite-ignore */ path);
      stage("scopes", "project", "scopes", [
        { name: longName, pattern: longPattern },
        ...Array.from({ length: 23 }, (_, i) => ({
          name: `Settlement area ${i + 1}`,
          pattern: `file:services/area-${i + 1}//*.ts`,
        })),
      ]);
      selectPage("scopes");
    },
    { longName, longPattern },
  );
  const scopes = dialog.getByRole("listbox", { name: "Scopes", exact: true });
  const toolbar = dialog.getByRole("toolbar", { name: "Scopes actions" });
  const name = dialog.getByRole("textbox", { name: /^Name:?$/ });
  const pattern = dialog.getByRole("textbox", { name: /^Pattern:?$/ });
  await expect(name).toHaveValue(longName);
  await expect(pattern).toHaveValue(longPattern);
  expect((await name.boundingBox())!.x).toBeGreaterThan(
    (await scopes.boundingBox())!.x + (await scopes.boundingBox())!.width,
  );
  const first = scopes.getByRole("option", { name: longName, exact: true });
  await expect(first.getByTitle(new RegExp(longName))).toBeVisible();
  expect(await scopes.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await scopes.focus();
  await page.keyboard.press("End");
  const last = scopes.getByRole("option", { name: "Settlement area 23", exact: true });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(pattern).toHaveValue("file:services/area-23//*.ts");
  expect(await scopes.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await expect(toolbar).toBeInViewport({ ratio: 1 });

  await page.setViewportSize({ width: 650, height: 730 });
  const listBounds = (await scopes.boundingBox())!;
  expect((await name.boundingBox())!.y).toBeGreaterThan(listBounds.y + listBounds.height);
  await toolbar.getByRole("button", { name: "Add", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Scope");
  expect(await name.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
  const added = scopes.getByRole("option", { name: "Scope", exact: true });
  await expect(added).toHaveAttribute("aria-selected", "true");
  await expect(added).toBeInViewport({ ratio: 1 });
  await page.keyboard.type("Settlement exports");
  await pattern.fill("file:exports//*.csv");
  await expect(scopes.getByRole("option", { name: "Settlement exports", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
