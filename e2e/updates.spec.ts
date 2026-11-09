import { expect, test } from "./fixtures";

test("Updates shows check status and keeps manual checks available when automatic checks are off", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const ipcPath = "/src/platform/ipc.ts";
    const actionsPath = "/src/platform/actions.ts";
    const { commands } = await import(/* @vite-ignore */ ipcPath);
    const { registerAction, executeAction } = await import(/* @vite-ignore */ actionsPath);
    Object.assign(commands, {
      appBuildInfo: async () => ({ version: "0.1.39", updates: true }),
      appUpdateStatus: async () => ({ status: "ok", data: { lastChecked: null, checking: false } }),
    });
    registerAction({
      id: "app.checkForUpdates",
      title: "Check for Updates…",
      run: () => document.body.setAttribute("data-update-checked", "true"),
    });
    await executeAction("file.settings", "general");
  });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("update");
  await dialog.getByRole("treeitem", { name: "Updates", exact: true }).click();
  await expect(dialog.getByText("0.1.39", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Never", { exact: true })).toBeVisible();
  const automatic = dialog.getByRole("checkbox", { name: "Check for updates automatically" });
  await expect(automatic).toBeChecked();
  await automatic.uncheck();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(automatic).not.toBeChecked();
  await dialog.getByRole("button", { name: "Check Now", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-update-checked", "true");
});

test("builds without update endpoints hide Updates from settings and search", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const ipcPath = "/src/platform/ipc.ts";
    const actionsPath = "/src/platform/actions.ts";
    const { commands } = await import(/* @vite-ignore */ ipcPath);
    commands.appBuildInfo = async () => ({ version: "0.1.39", updates: false });
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("file.settings", "general");
  });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("treeitem", { name: "Updates", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Update source", { exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("update");
  await expect(dialog.getByRole("treeitem", { name: "Updates", exact: true })).toHaveCount(0);
});
