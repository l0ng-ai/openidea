import { expect, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test("offers file templates for the selected workspace member", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const markers: Record<string, string> = {
      "/work/api": "go.mod",
      "/work/web": "pom.xml",
      "/work/library": "pom.xml",
    };
    window.__ipc.handlers.fs_read_dir = ({ path }) => {
      const name = markers[String(path)];
      return name ? [{ name, path: `${path}/${name}`, kind: "file", size: 0, mtimeMs: 0 }] : [];
    };
    window.__ipc.handlers.run_configs = () => [
      {
        id: "workspace:web:tomcat",
        name: "Web / Tomcat",
        kind: "tomcat",
        command: "catalina",
        args: ["run"],
        cwd: "/work/web",
        module: "/work/web",
        env: {},
        detected: true,
        isTest: false,
        debugAdapter: null,
      },
    ];
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const current = useProject.getState().project;
    useProject.setState({
      project: {
        ...current,
        name: "Workspace",
        root: "/workspace",
        workspace: { version: 1, name: "Workspace", projects: Object.keys(markers) },
      },
    });
  });

  const newMenu = async (path: string) => {
    await page.locator(`[data-project-path="${path}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "New", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: "From Template…", exact: true })).toBeVisible();
  };
  await newMenu("/work/api");
  await expect(page.getByRole("menuitem", { name: "Go File", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("go-new-menu.png"), animations: "disabled" });
  await expect(page.getByRole("menuitem", { name: "Go Module", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "JSON File", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Java Class", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Tomcat Context Descriptor", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await newMenu("/work/web");
  await expect(page.getByRole("menuitem", { name: "Java Class", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Tomcat Context Descriptor", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Go File", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "TypeScript File", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("tomcat-new-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.locator('[data-project-path="/work/library"]').click();
  await page.keyboard.press("Meta+n");
  const popup = page.getByRole("dialog", { name: "New", exact: true });
  await expect(popup.getByText("Java Class", { exact: true })).toBeVisible();
  await expect(popup.getByText("Tomcat Context Descriptor", { exact: true })).toHaveCount(0);
  await expect(popup.getByText("Go File", { exact: true })).toHaveCount(0);
});

test("uses the single project's type in the keyboard New popup", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.fs_read_dir = ({ path }) =>
      path === "/work/script" ? [{ name: "pyproject.toml", path: "/work/script/pyproject.toml", kind: "file" }] : [];
    window.__ipc.handlers.run_configs = () => [];
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    useProject.setState({
      project: { ...useProject.getState().project, name: "script", root: "/work/script" },
    });
  });
  await page.locator('[data-project-path="/work/script"]').click();
  await page.keyboard.press("Meta+n");
  const popup = page.getByRole("dialog", { name: "New", exact: true });
  await expect(popup.getByText("Python File", { exact: true })).toBeVisible();
  await expect(popup.getByText("Go File", { exact: true })).toHaveCount(0);
  await expect(popup.getByText("Tomcat Context Descriptor", { exact: true })).toHaveCount(0);
  await popup.getByRole("textbox", { name: "Search for file type" }).fill("from template");
  await popup.getByText("From Template…", { exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "New File from Template" }).getByText("Go File", { exact: true }),
  ).toBeVisible();
});
