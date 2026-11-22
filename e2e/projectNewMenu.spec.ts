import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

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

test("keeps the search aligned and visible while scrolling the New popup", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 540, height: 320 });
  await page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        appearance: { ...settings?.appearance, theme: "dark", syncWithOs: false, compactMode: true },
      },
    });
  });
  await expect(page.locator("html")).toHaveAttribute("data-compact", "");
  await page
    .getByRole("toolbar", { name: "Tool windows", exact: true })
    .getByRole("button", { name: "Project", exact: true })
    .click();
  await page.locator('[data-project-path="/dev/acme-api"]').click();
  await page.keyboard.press("Meta+n");

  const popup = page.getByRole("dialog", { name: "New", exact: true });
  const search = popup.getByRole("textbox", { name: "Search for file type" });
  const list = popup.getByRole("listbox", { name: "File types" });
  const selected = list.getByRole("option", { selected: true });
  await expect(search).toBeFocused();
  await expect(selected).toHaveCSS("height", "22px");
  await expect(search).toHaveCSS("height", "22px");
  const searchBox = (await search.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  const firstLabel = (await selected.getByText("File", { exact: true }).boundingBox())!;
  expect(searchBox.x).toBeCloseTo(firstLabel.x);
  expect(searchBox.y + searchBox.height).toBeLessThan(listBox.y);
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

  await search.press("ArrowUp");
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(selected).toBeInViewport({ ratio: 1 });
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport({ ratio: 1 });
});

test("names a file from a template and keeps keyboard kind selection visible in a short window", async ({
  workbench: page,
}) => {
  const root = "/dev/acme-api";
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.fs_create_file = () => null;
  });
  await page.locator(`[data-project-path="${root}"]`).click();
  await page.keyboard.press("Meta+n");
  const menu = page.getByRole("dialog", { name: "New", exact: true });
  await menu.getByRole("textbox", { name: "Search for file type" }).fill("from template");
  await menu.getByText("From Template…", { exact: true }).click();
  const templates = page.getByRole("dialog", { name: "New File from Template" });
  const kotlin = templates.getByRole("option", { name: "Kotlin Class/File", exact: true });
  await kotlin.hover();
  await expect(kotlin).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "New Kotlin Class/File", exact: true });
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  const kinds = dialog.getByRole("listbox", { name: "Kind", exact: true });
  await expect(name).toBeFocused();
  await page.setViewportSize({ width: 430, height: 380 });
  const bounds = (await dialog.boundingBox())!;
  expect(Math.abs(bounds.y + bounds.height / 2 - 190)).toBeLessThan(12);
  await expect.poll(() => kinds.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("Enter a name");
  await name.fill("OrderSummary");
  await name.press("ArrowUp");
  const last = kinds.getByRole("option", { name: "JUnit 5 Test", selected: true });
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(name).toBeFocused();
  for (let i = 0; i < 3; i++) await name.press("ArrowUp");
  await expect(kinds.getByRole("option", { name: "Data class", selected: true })).toBeVisible();
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => ipcCalls(page, "fs_create_file")).toEqual([{ path: `${root}/OrderSummary.kt` }]);
  await expect(page.getByRole("tab", { name: "OrderSummary.kt" })).toHaveAttribute("aria-selected", "true");
});
