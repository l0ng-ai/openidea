import { expect, test } from "./fixtures";

test("data source tabs share a stable layout and scroll within a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 560, height: 480 });
  await page.evaluate(async () => {
    const path = "/src/features/database/store.ts";
    const { openSourceDialog } = await import(/* @vite-ignore */ path);
    openSourceDialog(null, { name: "Local development", driver: "postgres", host: "localhost" });
  });

  const dialog = page.getByRole("dialog", { name: "New Data Source" });
  const panel = dialog.getByRole("tabpanel");
  const dialogSize = () => dialog.evaluate((element: HTMLElement) => [element.offsetWidth, element.offsetHeight]);
  await expect(panel.getByRole("textbox", { name: "Host:" })).toBeVisible();
  const size = await dialogSize();
  await dialog.getByRole("tab", { name: "SSH/SSL" }).click();
  await expect(dialog.getByRole("tab", { name: "SSH/SSL" })).toHaveAttribute("aria-selected", "true");
  expect(await dialogSize()).toEqual(size);

  await dialog.getByRole("tab", { name: "General" }).click();
  const canScroll = await panel.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(canScroll).toBe(true);
  await panel.getByRole("textbox", { name: "URL:" }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
});

for (const kind of ["password", "sshSecret", "params"] as const) {
  test(`database ${kind} dialog keeps its fields inside the window`, async ({ workbench: page }) => {
    await page.evaluate(async (kind) => {
      const path = "/src/features/database/store.ts";
      const { openDialog } = await import(/* @vite-ignore */ path);
      const source = {
        id: "layout-test",
        name: "Layout test",
        driver: "postgres",
        user: "account_".repeat(30),
        ssh: { enabled: true, host: "bastion.example.invalid", auth: "password" },
      };
      if (kind === "password") openDialog({ kind, source, resolve: () => {} });
      else if (kind === "sshSecret")
        openDialog({ kind, source, prompt: "SSH password required for " + "host_".repeat(30), resolve: () => {} });
      else openDialog({ kind, names: ["parameter_".repeat(25)], resolve: () => {} });
    }, kind);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const width of [1000, 640, 500]) {
      await page.setViewportSize({ width, height: 760 });
      const fits = await dialog.evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        return [...dialog.querySelectorAll("input, [class*='form_']")].every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= box.left && r.right <= box.right && el.scrollWidth <= el.clientWidth + 1;
        });
      });
      expect(fits).toBe(true);
    }
  });
}
