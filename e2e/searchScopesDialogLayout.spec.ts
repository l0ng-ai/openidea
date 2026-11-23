import { expect, test } from "./fixtures";

test("Find in Files keeps the scope list and pattern editor usable in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 700 });
  const longName = "Regional settlement reconciliation sources for month-end audit and publication";
  await page.evaluate(async (longName) => {
    const search = "/src/platform/search.ts";
    const { saveCustomScopes } = await import(/* @vite-ignore */ search);
    saveCustomScopes(
      Array.from({ length: 26 }, (_, i) => ({
        name: i ? `Reconciliation scope ${i + 1}` : longName,
        pattern: i ? `file:src/scope-${i + 1}//*` : "file:src/reconciliation//*",
      })),
    );
  }, longName);
  await page.keyboard.press("Meta+Shift+F");
  const find = page.getByRole("dialog", { name: "Find in Files", exact: true });
  await find.getByRole("tab", { name: "Scope", exact: true }).click();
  const openScopes = find.getByRole("button", { name: "Edit Scopes…", exact: true });
  await openScopes.click();

  const dialog = page.getByRole("dialog", { name: "Scopes", exact: true });
  const list = dialog.getByRole("list", { name: "Scopes", exact: true });
  const name = dialog.getByRole("textbox", { name: "Name:", exact: true });
  const pattern = dialog.getByRole("textbox", { name: "Pattern:", exact: true });
  await expect(pattern).toHaveValue("file:src/reconciliation//*");
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await expect(list.getByRole("button", { name: longName })).toHaveAttribute("title", longName);
  expect((await list.boundingBox())!.x).toBeLessThan((await name.boundingBox())!.x);

  await page.setViewportSize({ width: 460, height: 530 });
  // The dialog relays out over a few frames after the resize; measure once it has settled.
  let fields = (await pattern.boundingBox())!;
  await expect(async () => {
    const previous = fields.y;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    fields = (await pattern.boundingBox())!;
    expect(fields.y).toBe(previous);
  }).toPass();
  expect(fields.y).toBeGreaterThanOrEqual((await list.boundingBox())!.y + (await list.boundingBox())!.height);
  expect(fields.width).toBeGreaterThan(250);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect((await pattern.boundingBox())!.y).toBeCloseTo(fields.y, 0);
  const toolbar = dialog.getByRole("toolbar", { name: "Scopes actions" });
  const add = toolbar.getByRole("button", { name: "Add Scope", exact: true });
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  await expect(add).toBeInViewport({ ratio: 1 });
  await expect(ok).toBeInViewport({ ratio: 1 });

  await name.fill("Unsaved selection");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openScopes.click();
  await expect(name).toHaveValue(longName);
  await add.click();
  const draft = list.getByRole("button", { name: "Unnamed", exact: true });
  await expect(draft).toHaveAttribute("aria-current", "true");
  await expect(draft).toBeInViewport({ ratio: 1 });
  await expect(ok).toBeDisabled();
  await name.fill("Release inputs");
  await pattern.fill("file:src/release//*");
  await ok.click();
  await expect(dialog).toBeHidden();
  await openScopes.click();
  await list.getByRole("button", { name: "Release inputs", exact: true }).click();
  await expect(pattern).toHaveValue("file:src/release//*");
});
