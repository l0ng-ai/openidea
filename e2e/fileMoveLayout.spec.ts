import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const root = "/dev/acme-api";
const name = `InternationalSettlement${"Reconciliation".repeat(10)}.txt`;
const destination = `archive/Approved${"Settlement".repeat(11)}`;

test("keeps a long source name and destination readable while moving a file", async ({ workbench: page }) => {
  await page.evaluate(
    async ({ root, name, destination }) => {
      const fsModule = "/src/features/project-tree/fs.ts";
      const { projectFs } = await import(/* @vite-ignore */ fsModule);
      const storeModule = "/src/features/project-tree/store.ts";
      const { loadDir } = await import(/* @vite-ignore */ storeModule);
      const fs = projectFs(root);
      await fs.createFile(`${root}/${name}`);
      await fs.createDir(`${root}/archive`);
      await fs.createDir(`${root}/${destination}`);
      await loadDir(root, true);
    },
    { root, name, destination },
  );
  await page.getByRole("treeitem", { name, exact: true }).click();
  await page.keyboard.press("F6");

  const dialog = page.getByRole("dialog", { name: "Move", exact: true });
  const field = dialog.getByRole("textbox", { name: "Target directory" });
  await expect(field).toBeFocused();
  await page.setViewportSize({ width: 470, height: 480 });
  await expect
    .poll(() => dialog.locator("[data-dialog-body]").evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  expect(
    await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)),
  ).toBe("acme-api");
  const submit = dialog.getByRole("button", { name: "Refactor", exact: true });
  await expect(submit).toBeDisabled();
  await field.fill(destination);
  await expect(dialog.getByText(destination, { exact: true })).toBeVisible();
  await expect(submit).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("checkbox", { name: "Search for references" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Search in comments and strings" }).uncheck();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        async ({ root, destination }) => {
          const fsModule = "/src/features/project-tree/fs.ts";
          const { projectFs } = await import(/* @vite-ignore */ fsModule);
          return (await projectFs(root).readDir(`${root}/${destination}`)).map((entry: { name: string }) => entry.name);
        },
        { root, destination },
      ),
    )
    .toEqual([name]);
});

test("browses for a destination and keeps the current path on cancel", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.file_dialog_needs_gtk = () => false;
    let chosen: string | null = null;
    window.__ipc.handlers["plugin:dialog|open"] = () => {
      const result = chosen;
      chosen = "C:\\Projects\\Invoice Archive";
      return result;
    };
  });
  await page.keyboard.press("F6");
  const dialog = page.getByRole("dialog", { name: "Move", exact: true });
  const field = dialog.getByRole("textbox", { name: "Target directory" });
  const browse = dialog.getByRole("button", { name: "Browse for target directory", exact: true });
  await browse.click();
  await expect.poll(() => ipcCalls(page, "plugin:dialog|open")).toHaveLength(1);
  await expect(field).toHaveValue(root);
  await browse.click();
  await expect(field).toHaveValue("C:/Projects/Invoice Archive");
  await expect(dialog.getByRole("button", { name: "Refactor", exact: true })).toBeEnabled();
  await field.fill("C:/");
  await expect(dialog.getByText("C:/", { exact: true })).toBeVisible();
  await field.fill("/");
  await expect(dialog.getByText("/", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
