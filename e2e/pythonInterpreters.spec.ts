import { expect, test, stubDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

/** Settings › Languages & Frameworks › Python › All Interpreters over a stubbed backend. */
async function interpretersPage(page: Page) {
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const project = useProject.getState().project!;
    const current = useProject.getState().settings ?? {};
    const settings = {
      ...current,
      languages: {
        ...(current.languages ?? {}),
        python: {
          interpreter: "/project/.venv/bin/python",
          activateVirtualenv: true,
          interpreters: ["/envs/tools/bin/python"],
          hiddenInterpreters: ["/usr/bin/python3.9"],
          hideOtherProjectInterpreters: false,
          showInterpreterPaths: true,
        },
      },
    };
    useProject.setState({ settings });
    const sdk = (path: string, name: string, home: string | null, source: string) => ({
      path,
      name,
      version: "3.12.0",
      source,
      home,
      extra: null,
    });
    window.__ipc.handlers.settings_get = () => settings;
    window.__ipc.handlers.settings_get_global = () => settings;
    window.__ipc.handlers.project_current = () => ({ ...project, settings });
    window.__ipc.handlers.sdk_detect = () => [
      sdk("/usr/bin/python3", "Python 3.12", "/usr", "system"),
      sdk("/usr/bin/python3.9", "Python 3.9", "/usr", "system"),
      sdk("/project/.venv/bin/python", "Python 3.12 (.venv)", "/project/.venv", "venv"),
    ];
    window.__ipc.handlers.sdk_python_project_interpreters = () => [
      {
        project: "/apps/shop",
        sdk: sdk("/apps/shop/.venv/bin/python", "Python 3.11 (shop)", "/apps/shop/.venv", "venv"),
      },
    ];
    window.__ipc.handlers.sdk_python_interpreter = () =>
      sdk("/envs/tools/bin/python", "Python 3.13 (tools)", "/envs/tools", "venv");
    const actions = "/src/platform/actions.ts";
    void (await import(/* @vite-ignore */ actions)).executeAction("file.settings", "python.interpreters");
  });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("lists interpreters with their project, filters and toggles paths", async ({ workbench: page }) => {
  await stubDesktop(page);
  const dialog = await interpretersPage(page);
  const row = (name: RegExp) => dialog.getByRole("option", { name });

  await expect(row(/Python 3\.11 \(shop\)/)).toBeVisible();
  await expect(row(/Python 3\.13 \(tools\)/)).toBeVisible();
  // Removed earlier: not listed even though detection finds it.
  await expect(row(/Python 3\.9/)).toHaveCount(0);
  await expect(dialog.getByText("Project interpreter")).toBeVisible();
  await expect(dialog.getByText("/project/.venv/bin/python")).toBeVisible();

  await dialog.getByRole("button", { name: "Hide Interpreters from Other Projects" }).click();
  await expect(row(/Python 3\.11 \(shop\)/)).toHaveCount(0);
  await expect(row(/Python 3\.12 \(\.venv\)/)).toBeVisible();

  await dialog.getByRole("button", { name: "Show Interpreter Paths" }).click();
  await expect(dialog.getByText("/project/.venv/bin/python")).toHaveCount(0);
});

test("removes an interpreter in use and drops it from the interpreter combo", async ({ workbench: page }) => {
  await stubDesktop(page);
  const dialog = await interpretersPage(page);

  await dialog.getByRole("option", { name: /Python 3\.12 \(\.venv\)/ }).click();
  await dialog.getByRole("button", { name: "Remove Interpreter" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Interpreter" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(dialog.getByRole("option", { name: /Python 3\.12 \(\.venv\)/ })).toHaveCount(0);

  // The project interpreter page offers what the list keeps: no removed path, added environments included.
  await dialog.getByRole("treeitem", { name: "Dependencies", exact: true }).click();
  await dialog.getByRole("button", { name: "Python interpreter" }).click();
  await expect(page.getByRole("option", { name: /Python 3\.13 \(tools\)/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Python 3\.9/ })).toHaveCount(0);
});
