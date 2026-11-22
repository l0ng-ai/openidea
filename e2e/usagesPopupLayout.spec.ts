import { expect, test } from "./fixtures";

test("Show Usages distinguishes same-named files without losing the line or snippet", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 480, height: 620 });
  await page.evaluate(async () => {
    const usages = "/src/features/code-insight/usages.ts";
    const { useUsagesPopup } = await import(/* @vite-ignore */ usages);
    const symbol = "submitOrder";
    useUsagesPopup.setState({
      open: true,
      anchor: { x: 30, y: 90 },
      symbol,
      groups: (
        [
          ["/dev/acme-api/packages/billing/src/Routes.ts", "return submitOrder(invoice);"],
          ["/dev/acme-api/packages/checkout/src/Routes.ts", "return submitOrder(cart);"],
          ["/dev/acme-api/src/Worker.ts", "await submitOrder(job);"],
        ] as const
      ).map(([path, text]) => {
        const col = text.indexOf(symbol);
        return { path, usages: [{ path, line: 6, col, endCol: col + symbol.length, text }] };
      }),
    });
  });

  const popup = page.getByRole("dialog", { name: "Usages", exact: true });
  const rows = popup.getByRole("option");
  const billing = rows.filter({ hasText: "invoice" });
  const checkout = rows.filter({ hasText: "cart" });
  await expect(rows).toHaveCount(3);
  for (const [row, directory] of [
    [billing, "billing"],
    [checkout, "checkout"],
  ] as const) {
    await expect(row.getByText("Routes.ts", { exact: true })).toBeVisible();
    const caption = row.getByText(directory, { exact: true });
    await expect(caption).toBeVisible();
    expect(await caption.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(row.getByText("7", { exact: true })).toBeVisible();
    await expect(row.locator("mark")).toHaveText("submitOrder");
  }

  await expect(checkout.getByTitle("/dev/acme-api/packages/checkout/src/Routes.ts", { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "Worker.ts" }).getByText("src", { exact: true })).toHaveCount(0);
});
