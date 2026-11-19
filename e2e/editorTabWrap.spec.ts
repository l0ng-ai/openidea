import { expect, openFromTree, test } from "./fixtures";

test("fits a long wrapped tab and its close button inside a narrow editor group", async ({ workbench: page }) => {
  const filename = "QuarterlyReconciliationAndCheckoutAllocation.test.ts";
  await page.setViewportSize({ width: 720, height: 760 });
  await openFromTree(page, "README.md");
  await page.evaluate(async (filename) => {
    const projectModule = "/src/platform/project.ts";
    const projectFilesModule = "/src/features/project-tree/fs.ts";
    const editorModule = "/src/editor/core/controller.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { projectFs } = await import(/* @vite-ignore */ projectFilesModule);
    const { editorController, useTabs } = await import(/* @vite-ignore */ editorModule);
    const { project, settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        editor: { ...settings?.editor, tabs: { ...settings?.editor?.tabs, multipleRows: true } },
      },
    });
    const path = `${project.root}/${filename}`;
    await projectFs(project.root).createFile(path);
    await editorController().openFilesIn([path], useTabs.getState().activePane, "right");
  }, filename);

  const tab = page.getByRole("tab", { name: filename, exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      tab.evaluate((element) => {
        const close = element.parentElement?.querySelector("[data-tab-close]");
        const strip = element.closest('[role="tablist"]');
        return !!close && !!strip && close.getBoundingClientRect().right <= strip.getBoundingClientRect().right;
      }),
    )
    .toBe(true);
  await tab.locator("..").getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(tab).toBeHidden();
});
