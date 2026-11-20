import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Spelling puts dictionary files first and keeps accepted words in separate scopes", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 820 });
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.settings_get_global = () => ({});
    window.__ipc.handlers.settings_get = () => ({});
    window.__ipc.handlers.settings_set = () => ({});
  });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Spelling");
  await settings.getByRole("treeitem", { name: "Spelling", exact: true }).click();
  await search.clear();

  const files = settings.getByRole("region", { name: "Custom dictionaries", exact: true });
  const words = settings.getByRole("region", { name: "Accepted words", exact: true });
  const filesList = files.getByRole("listbox", { name: "Custom dictionaries", exact: true });
  const project = words.getByRole("tab", { name: "Project dictionary", exact: true });
  const application = words.getByRole("tab", { name: "Application dictionary", exact: true });
  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 820 });
    const [filesBox, wordsBox] = await Promise.all([files.boundingBox(), words.boundingBox()]);
    if (!filesBox || !wordsBox) throw new Error("Missing Spelling sections");
    expect(filesBox.y + filesBox.height).toBeLessThan(wordsBox.y);
    const [paths, accepted] = await Promise.all([filesList.boundingBox(), words.getByRole("listbox").boundingBox()]);
    if (!paths || !accepted) throw new Error("Missing dictionary lists");
    expect(paths.width).toBeCloseTo(accepted.width, 0);
    if (width === 1120) expect(paths.width).toBeGreaterThan(480);
    await expect(project).toBeInViewport({ ratio: 1 });
    await expect(application).toBeInViewport({ ratio: 1 });
  }

  await files.getByRole("button", { name: "Add", exact: true }).click();
  await files.getByRole("textbox", { name: "Dictionary path" }).fill("dictionaries/team.dic");
  await files.getByRole("textbox", { name: "Dictionary path" }).press("Enter");
  await expect(filesList.getByRole("option", { name: "dictionaries/team.dic" })).toBeVisible();

  await expect(project).toHaveAttribute("aria-selected", "true");
  await words.getByRole("button", { name: "Add", exact: true }).click();
  await words.getByRole("textbox", { name: "Word", exact: true }).fill("checkoutable");
  await words.getByRole("textbox", { name: "Word", exact: true }).press("Enter");
  await project.press("ArrowRight");
  await expect(application).toHaveAttribute("aria-selected", "true");
  await expect(words.getByRole("option", { name: "checkoutable" })).toHaveCount(0);
  await words.getByRole("button", { name: "Add", exact: true }).click();
  await words.getByRole("textbox", { name: "Word", exact: true }).fill("worktree");
  await words.getByRole("textbox", { name: "Word", exact: true }).press("Enter");

  await project.click();
  await expect(words.getByRole("option", { name: "checkoutable" })).toBeVisible();
  await expect(words.getByRole("option", { name: "worktree" })).toHaveCount(0);
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await ipcCalls(page, "settings_set")).sort((a, b) => String(a.key).localeCompare(String(b.key))))
    .toEqual([
      { scope: "global", key: "spelling.customDictionaries", value: JSON.stringify(["dictionaries/team.dic"]) },
      { scope: "global", key: "spelling.ideWords", value: JSON.stringify(["worktree"]) },
      { scope: "project", key: "spelling.projectWords", value: JSON.stringify(["checkoutable"]) },
    ]);
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(async () => {
    const actionModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionModule);
    await executeAction("file.newProjectsSettings", "editor.naturalLanguages.spelling");
  });
  const defaults = page.getByRole("dialog", { name: "Settings for New Projects", exact: true });
  await expect(defaults.getByRole("listbox", { name: "Application dictionary", exact: true })).toBeVisible();
  await expect(defaults.getByRole("tablist", { name: "Accepted words" })).toHaveCount(0);
  await expect(defaults.getByRole("listbox", { name: "Project dictionary", exact: true })).toHaveCount(0);
});
