import { expect, openFromTree, test } from "./fixtures";

test("multiline editor search keeps three visible lines and replaces with the full text", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await page.setViewportSize({ width: 540, height: 500 });
  const content = editor.locator(".cm-content");
  const query = "currency=EUR\nregion=eu-west\npipeline=clearing\nmode=batch\ntimeout=30\nretries=2";
  const replacement = query.replace("clearing", "settlement").replace("timeout=30", "timeout=45");
  await content.press("Meta+a");
  await page.keyboard.insertText(`[ledger]\n${query}\n\n[reporting]\n${query}\n`);
  await content.press("Escape");
  await content.press("Meta+r");

  const bar = page.getByRole("search", { name: "Replace in file" });
  const find = bar.getByRole("textbox", { name: "Find", exact: true });
  const replace = bar.getByRole("textbox", { name: "Replace", exact: true });
  await find.fill(query);
  await replace.fill(replacement);
  for (const field of [find, replace]) {
    const visibleLines = await field.evaluate((el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight));
    expect(visibleLines).toBeCloseTo(3);
    await field.press("Control+End");
    await expect.poll(() => field.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  }
  await expect(find).toHaveValue(query);
  await expect(replace).toHaveValue(replacement);
  const count = bar.locator("[aria-live]");
  await expect(count).toHaveText(/\/2$/);
  const selected = await count.innerText();
  const next = bar.getByRole("button", { name: /Next Occurrence/ });
  await next.click();
  await expect(count).toHaveText(/^[12]\/2$/);
  await expect(count).not.toHaveText(selected);

  await bar.getByRole("button", { name: "Replace All", exact: true }).click();
  await expect(editor.locator(".cm-line", { hasText: "timeout=45" })).toHaveCount(2);
  await expect(editor.locator(".cm-line", { hasText: "pipeline=clearing" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Close", exact: true }).click();
  await expect(content).toBeFocused();
  await content.press("Meta+z");
  await expect(editor.locator(".cm-line", { hasText: "pipeline=clearing" })).toHaveCount(2);
});
