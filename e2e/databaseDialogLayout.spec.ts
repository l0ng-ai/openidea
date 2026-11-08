import { expect, test } from "./fixtures";

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
