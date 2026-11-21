import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Project Libraries groups attachments below one toolbar and saves the selected root changes", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1150, height: 780 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    const libraries = [
      {
        name: "Settlement Reports",
        scope: "compile",
        classes: ["lib/report.jar", "build/report-classes"],
        sources: ["lib/report-sources.jar", "vendor/settlement-java-source-archive-for-monthly-audit-review/src"],
        javadocs: ["docs/reports"],
      },
    ];
    const settings = { ...useProject.getState().settings, projectStructure: { libraries } };
    useProject.setState({ settings });
    const handlers = window.__ipc.handlers;
    handlers.settings_get_global = () => settings;
    handlers.settings_set = ({ value }) => ({
      ...settings,
      projectStructure: { libraries: JSON.parse(String(value)) },
    });
    handlers.sdk_project_libraries = () => [];
    handlers.file_dialog_needs_gtk = () => false;
    handlers["plugin:dialog|open"] = () => "/dev/acme-api/lib/official-sources.jar";
    const stagePath = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ stagePath)).openProjectStructure("libraries");
  });

  const dialog = page.getByRole("dialog", { name: "Project Structure" });
  const toolbar = dialog.getByRole("toolbar", { name: "Library Roots" });
  const tree = dialog.getByRole("tree", { name: "Library Roots" });
  await expect(toolbar).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Classes", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem", { name: "Sources", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem", { name: "lib/report.jar", exact: true })).toBeVisible();
  await expect(tree.getByText("lib/report.jar", { exact: true })).toHaveCSS("font-size", "13px");
  const remove = toolbar.getByRole("button", { name: "Remove Library Root", exact: true });
  await expect(remove).toBeDisabled();

  await tree.getByRole("treeitem", { name: "Sources", exact: true }).click();
  await expect(remove).toBeDisabled();
  await tree.getByRole("treeitem", { name: "lib/report-sources.jar", exact: true }).click();
  await remove.click();
  await expect(tree.getByRole("treeitem", { name: "lib/report-sources.jar", exact: true })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "lib/report.jar", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 720, height: 680 });
  await expect(toolbar).toBeInViewport({ ratio: 1 });
  await expect(tree).toBeInViewport({ ratio: 1 });
  await toolbar.getByRole("button", { name: "Attach Library Root", exact: true }).click();
  await page.getByRole("menuitem", { name: "Attach Sources…", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "lib/official-sources.jar", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Library scope" })).toBeVisible();

  expect(await ipcCalls(page, "settings_set")).toEqual([]);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => {
      const calls = await ipcCalls(page, "settings_set");
      return calls.map(({ key, value }) => ({ key, value: JSON.parse(String(value)) }));
    })
    .toEqual([
      {
        key: "projectStructure.libraries",
        value: [
          {
            name: "Settlement Reports",
            classes: ["lib/report.jar", "build/report-classes"],
            sources: ["vendor/settlement-java-source-archive-for-monthly-audit-review/src", "lib/official-sources.jar"],
            javadocs: ["docs/reports"],
            scope: "compile",
          },
        ],
      },
    ]);
});
