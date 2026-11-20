import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openConfirmation(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Remove silently");
  await dialog.getByRole("treeitem", { name: "Confirmation", exact: true }).click();
  await search.clear();
  return dialog;
}

test("VCS confirmation aligns the file policy selectors and keeps edits scoped", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  await stubDesktop(page);
  await page.evaluate(() => {
    const global = { onCreate: "ask", onDelete: "ask" };
    const project: Partial<typeof global> = {};
    const effective = () => ({ vcs: { confirmation: { ...global, ...project } } });
    const handlers = window.__ipc.handlers;
    handlers.settings_get_global = () => ({ vcs: { confirmation: global } });
    handlers.settings_get = effective;
    handlers.settings_set = ({ scope, key, value }) => {
      const policy = String(key).split(".").at(-1);
      if (policy !== "onCreate" && policy !== "onDelete") throw new Error("Unexpected confirmation setting");
      const layer = scope === "project" ? project : global;
      layer[policy] = JSON.parse(String(value));
      return effective();
    };
  });
  const dialog = await openConfirmation(page);
  const create = dialog.getByRole("button", { name: "When files are created", exact: true });
  const remove = dialog.getByRole("button", { name: "When files are deleted", exact: true });
  const global = dialog.getByRole("radio", { name: "Global", exact: true });
  const project = dialog.getByRole("radio", { name: "This project", exact: true });
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(create).toHaveText("Ask");
  await expect(remove).toHaveText("Ask");
  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(create).toBeInViewport({ ratio: 1 });
    await expect(remove).toBeInViewport({ ratio: 1 });
    const [createBox, removeBox] = await Promise.all([create.boundingBox(), remove.boundingBox()]);
    if (!createBox || !removeBox) throw new Error("Missing confirmation selector bounds");
    expect(createBox.y).toBeLessThan(removeBox.y);
    expect(createBox.x).toBeCloseTo(removeBox.x, 0);
    expect(createBox.width).toBeCloseTo(removeBox.width, 0);
  }

  await create.press("Enter");
  await expect(page.getByRole("listbox", { name: "When files are created", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(create).toHaveText("Add silently");
  await remove.click();
  await page.getByRole("option", { name: "Remove silently", exact: true }).click();
  await expect(remove).toHaveText("Remove silently");

  await project.click();
  await create.click();
  await page.getByRole("option", { name: "Do not add", exact: true }).click();
  await remove.click();
  await page.getByRole("option", { name: "Do not remove", exact: true }).click();
  await expect(create).toHaveText("Do not add");
  await expect(remove).toHaveText("Do not remove");
  await global.click();
  await expect(create).toHaveText("Add silently");
  await expect(remove).toHaveText("Remove silently");

  expect(await ipcCalls(page, "settings_set")).toEqual([]);
  await apply.click();
  await expect(apply).toBeDisabled();
  expect(await ipcCalls(page, "settings_set")).toEqual([
    { scope: "global", key: "vcs.confirmation.onCreate", value: '"silently"' },
    { scope: "global", key: "vcs.confirmation.onDelete", value: '"silently"' },
    { scope: "project", key: "vcs.confirmation.onCreate", value: '"never"' },
    { scope: "project", key: "vcs.confirmation.onDelete", value: '"never"' },
  ]);
  await cancel.click();
  await openConfirmation(page);
  await global.click();
  await expect(create).toHaveText("Add silently");
  await expect(remove).toHaveText("Remove silently");
  await project.click();
  await expect(create).toHaveText("Do not add");
  await expect(remove).toHaveText("Do not remove");
  await remove.click();
  await page.getByRole("option", { name: "Ask", exact: true }).click();
  await cancel.click();
  await openConfirmation(page);
  await project.click();
  await expect(remove).toHaveText("Do not remove");
});
