import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const parent = "/dev/imports/From-vendor/QuarterlySettlementReconciliationAndReportingProjects";
const project = `${parent}/settlement-api`;

test("the trust prompt keeps the folder scope and restricted preview visible in a narrow window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 420, height: 455 });
  await stubDesktop(page);
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    h.project_trust_status = ({ path }) => ({ root: path, trusted: false, decided: false });
    h.project_trust_set = () => null;
    h.open_project = ({ path }) => ({ root: path, name: "settlement-api", trusted: false, isGit: false, settings: {} });
    h.fs_read_dir = () => [];
  });
  const open = () =>
    page.evaluate(async (path) => {
      const projectModule = "/src/platform/project.ts";
      const { openProject } = await import(/* @vite-ignore */ projectModule);
      void openProject(path).catch(() => undefined);
    }, project);
  await open();

  const dialog = page.getByRole("dialog", { name: "Trust and Open Project?" });
  const restricted = dialog.getByRole("button", { name: "Preview in Restricted Mode" });
  const folder = dialog.getByRole("checkbox", { name: /Trust projects in/ });
  const projectAction = dialog.getByRole("button", { name: "Trust Project", exact: true });
  const folderAction = dialog.getByRole("button", { name: "Trust Folder", exact: true });
  await expect(restricted).toBeFocused();
  await expect(projectAction).toBeVisible();
  await expect(folder).not.toBeChecked();
  await expect(dialog.getByTitle(project, { exact: true })).toBeVisible();
  await expect(dialog.getByTitle(parent, { exact: true })).toBeVisible();
  await folder.check();
  await expect(folderAction).toHaveCount(1);
  await expect(projectAction).toHaveCount(0);
  for (const selector of ["[data-dialog-body]", "[data-dialog-footer]"]) {
    expect(await dialog.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await expect(restricted).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await ipcCalls(page, "project_trust_set")).toEqual([]);
  expect(await ipcCalls(page, "open_project")).toEqual([]);

  await open();
  await expect(projectAction).toBeVisible();
  await expect(folder).not.toBeChecked();
  await folder.check();
  await restricted.click();
  await expect(dialog).toBeHidden();
  expect(await ipcCalls(page, "project_trust_set")).toEqual([{ path: project, trusted: false, folder: false }]);
  await expect.poll(() => ipcCalls(page, "open_project")).toEqual([{ path: project }]);
});
