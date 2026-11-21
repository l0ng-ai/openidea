import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Module Sources fits in a narrow dialog and keeps marking folders after resizing", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const root = useProject.getState().project!.root;
    const settings = { ...useProject.getState().settings, projectStructure: { sourceRoots: ["src"] } };
    useProject.setState({ settings });
    const handlers = window.__ipc.handlers;
    handlers.fs_read_dir = ({ path }) =>
      path === root ? ["src", "audit-fixtures"].map((name) => ({ name, path: `${root}/${name}`, kind: "dir" })) : [];
    handlers.settings_get_global = () => settings;
    handlers.settings_set = () => settings;
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("file.projectStructure", "modules");
  });

  const dialog = page.getByRole("dialog", { name: "Project Structure" });
  const tree = dialog.getByRole("tree", { name: "Content root" });
  const marked = dialog.getByRole("region", { name: "Marked folders" });
  const divider = dialog.getByRole("separator", { name: "Marked folders" });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(marked.getByText("Source Folders")).toBeVisible();
  await expect(marked.getByText("Test Source Folders")).toHaveCount(0);
  const width = (await tree.boundingBox())!.width;
  await divider.press("ArrowRight");
  await expect.poll(async () => (await tree.boundingBox())!.width).toBeGreaterThan(width + 4);

  const folder = tree.getByRole("treeitem", { name: "audit-fixtures", exact: true });
  await folder.click();
  await page.setViewportSize({ width: 640, height: 720 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(folder).toHaveAttribute("aria-selected", "true");
  const content = dialog.locator("[class*='psDialogBody']");
  expect(await content.evaluate((element) => element.scrollWidth)).toBe(
    await content.evaluate((element) => element.clientWidth),
  );
  expect((await marked.boundingBox())!.y).toBeGreaterThan((await tree.boundingBox())!.y);
  await dialog.getByRole("toolbar", { name: "Mark as" }).getByRole("button", { name: "Tests", exact: true }).click();
  await expect(marked.getByText("Test Source Folders")).toBeVisible();
  await expect(marked.getByText("audit-fixtures", { exact: true })).toHaveCSS("font-size", "13px");
  await expect(marked.getByRole("button", { name: "Unmark audit-fixtures", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "settings_set")).toEqual([]);

  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "settings_set"))
    .toMatchObject([{ key: "projectStructure.testRoots", value: '["audit-fixtures"]' }]);
});
