import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Git settings keep the executable and Test button together at narrow widths", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 560, height: 740 });
  await stubDesktop(page);
  const gitPath = "C:/Program Files/Git/cmd/git.exe";
  const longPath = `C:/${"long-directory-name".repeat(20)}/git.exe`;
  await page.evaluate(
    ({ gitPath, longPath }) => {
      window.__ipc.handlers.vcs_detected_git = () => gitPath;
      window.__ipc.handlers.vcs_git_version = ({ path }) => ({ path: path || longPath, version: "git version 2.49.0" });
      window.__ipc.handlers.git_credentials = () => [];
    },
    { gitPath, longPath },
  );
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Path to Git executable");
  await dialog.getByRole("treeitem", { name: "Git", exact: true }).click();
  await search.clear();

  const path = dialog.getByRole("textbox", { name: /^Path to Git executable:?$/ });
  const testButton = dialog.getByRole("button", { name: "Test", exact: true });
  const branches = dialog.getByRole("textbox", { name: /^Protected branches:?$/ });
  await expect(path).toHaveAttribute("placeholder", `Auto-detected: ${gitPath}`);
  for (const width of [560, 580, 1120]) {
    await page.setViewportSize({ width, height: 740 });
    await path.scrollIntoViewIfNeeded();
    const [field, button, patterns] = await Promise.all([
      path.boundingBox(),
      testButton.boundingBox(),
      branches.boundingBox(),
    ]);
    if (!field || !button || !patterns) throw new Error("Missing Git settings control bounds");
    expect(field.y).toBeCloseTo(button.y, 0);
    if (width <= 580) {
      const label = await dialog.getByText("Path to Git executable", { exact: true }).boundingBox();
      if (!label) throw new Error("Missing Git executable label bounds");
      expect(label.y + label.height).toBeLessThan(field.y);
      expect(field.width).toBeGreaterThan(150);
    }
    expect(field.x + field.width).toBeLessThan(button.x);
    expect(button.x + button.width).toBeCloseTo(patterns.x + patterns.width, 0);
  }

  await page.setViewportSize({ width: 560, height: 740 });
  await testButton.click();
  const result = dialog.getByRole("status").filter({ hasText: "Git version is 2.49.0" });
  await expect(result).toContainText(longPath);
  await expect(result).toBeInViewport({ ratio: 1 });
  await path.fill(gitPath);
  await expect(result).toHaveCount(0);
  await testButton.click();
  await expect(result).toContainText(gitPath);
  expect(await ipcCalls(page, "vcs_git_version")).toEqual([{ path: "" }, { path: gitPath }]);
  expect(await ipcCalls(page, "settings_set")).toEqual([]);

  const update = dialog.getByRole("radiogroup", { name: "Update method" });
  const merge = update.getByRole("radio", { name: "Merge" });
  const rebase = update.getByRole("radio", { name: "Rebase" });
  await expect(merge).toBeChecked();
  await merge.press("ArrowRight");
  await expect(rebase).toBeChecked();
});
