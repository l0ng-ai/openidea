import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test("Attach preserves unsaved tabs and detaches back to the plain project", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("unsaved attach text");
  await page.screenshot({ path: test.info().outputPath("plain-project.png"), animations: "disabled" });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const project = useProject.getState().project;
    useProject.setState({
      settings: { ...project.settings, general: { ...project.settings.general, openProjectIn: "ask" } },
    });
    const attached = {
      ...project,
      displayName: "acme-api, other",
      workspace: { version: 1, name: project.name, projects: [project.root, "/dev/other"] },
    };
    let current = project;
    window.__ipc.handlers.project_trust_status = ({ path }) => ({ root: path, trusted: true, decided: true });
    window.__ipc.handlers.workspace_attach = () => {
      current = attached;
      return project.root;
    };
    window.__ipc.handlers.project_current = () => current;
    window.__ipc.handlers.menu_refresh = () => null;
    window.__ipc.handlers.project_rename = ({ name }) => {
      current = { ...attached, name, displayName: `${name}, other` };
      return current;
    };
    window.__ipc.handlers.workspace_update = () => {
      current = project;
      return project;
    };
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    window.__ipc.handlers.fs_read_dir = () => [];
    window.__ipc.handlers.run_configs = () => [];
    window.__ipc.handlers.recent_projects = () => [
      { path: current.root, name: current.displayName || current.name, branch: null, openedAtMs: Date.now() },
    ];
    const windows = "/src/features/app/windows.ts";
    void (await import(/* @vite-ignore */ windows)).openProjectWithPolicy("/dev/other");
  });
  const dialog = page.getByRole("dialog", { name: "Open Project" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("attach-dialog.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.locator("header").first().getByRole("button", { name: "acme-api, other", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /^other / })).toBeVisible();
  await expect(editor.locator(".cm-content")).toContainText("unsaved attach text");
  expect(await ipcCalls(page, "open_project")).toHaveLength(0);
  expect(await ipcCalls(page, "workspace_attach")).toHaveLength(1);
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    void (await import(/* @vite-ignore */ actions)).executeAction("file.renameProject");
  });
  const rename = page.getByRole("dialog", { name: "Rename Project", exact: true });
  await expect(rename.getByRole("textbox")).toHaveValue("acme-api");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.locator("header").first().getByRole("button", { name: "acme-api, other", exact: true }),
  ).toBeVisible();
  expect((await ipcCalls(page, "project_rename"))[0]!.name).toBe("acme-api");
  await page.screenshot({ path: test.info().outputPath("attached-project.png"), animations: "disabled" });
  await page.locator("header").first().getByRole("button", { name: "acme-api, other", exact: true }).click();
  await expect(page.getByText("/dev/acme-api", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("attached-recent.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("treeitem", { name: /^other / }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Detach Project", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove from Workspace" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("detach-menu.png"), animations: "disabled" });
  await page.getByRole("menuitem", { name: "Detach Project", exact: true }).click();
  const detach = page.getByRole("dialog", { name: "Detach Project" });
  await expect(detach).toBeVisible();
  await detach.getByRole("button", { name: "Detach", exact: true }).click();
  await expect(page.locator("header").first().getByRole("button", { name: "acme-api", exact: true })).toBeVisible();
  await expect(editor.locator(".cm-content")).toContainText("unsaved attach text");
  await expect(page.getByRole("treeitem", { name: /^other / })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("detached-project.png"), animations: "disabled" });
});

test("restricting an attached folder leaves the current project untouched", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    useProject.setState({ settings: { ...useProject.getState().settings, general: { openProjectIn: "ask" } } });
    let decided = false;
    window.__ipc.handlers.project_trust_status = ({ path }) => ({ root: path, trusted: false, decided });
    window.__ipc.handlers.project_trust_set = () => {
      decided = true;
    };
    const module = "/src/features/app/windows.ts";
    void (await import(/* @vite-ignore */ module)).openProjectWithPolicy("/dev/untrusted");
  });
  await page.getByRole("dialog", { name: "Open Project" }).getByRole("button", { name: "Attach", exact: true }).click();
  const trust = page.getByRole("dialog", { name: "Trust and Open Project?" });
  await expect(trust).toBeVisible();
  await trust.getByRole("button", { name: "Preview in Restricted Mode" }).click();
  await expect(trust).toBeHidden();
  expect(await ipcCalls(page, "workspace_attach")).toHaveLength(0);
  expect(await ipcCalls(page, "open_project")).toHaveLength(0);
  await expect(page.locator("header").first().getByRole("button", { name: "acme-api", exact: true })).toBeVisible();
});

test("restricted attachments can be trusted individually from the banner", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const m = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ m);
    const primary = useProject.getState().project;
    let current = {
      ...primary,
      trusted: false,
      displayName: "acme-api, other...",
      workspace: { version: 1, name: primary.name, projects: [primary.root, "/dev/other", "/dev/third"] },
    };
    const trusted = new Set([primary.root]);
    window.__ipc.handlers.project_trust_status = ({ path }) => ({
      root: path,
      trusted: trusted.has(path),
      decided: true,
    });
    window.__ipc.handlers.project_trust_set = ({ path, trusted: allow }) => {
      if (allow) trusted.add(path);
      current = { ...current, trusted: current.workspace.projects.every((path) => trusted.has(path)) };
    };
    window.__ipc.handlers.project_current = () => current;
    window.__ipc.handlers.fs_read_dir = () => [];
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    window.__ipc.handlers.run_configs = () => [];
    useProject.setState({ project: current });
  });
  const banner = page.getByRole("status").filter({ hasText: "Restricted Mode" });
  await expect(banner).toContainText("/dev/other");
  await page.screenshot({ path: test.info().outputPath("restricted-member.png"), animations: "disabled" });
  await banner.getByRole("button", { name: "Trust Project" }).click();
  const dialog = page.getByRole("dialog", { name: "Trust and Open Project?" });
  await expect(dialog).toContainText("/dev/other");
  await dialog.getByRole("button", { name: "Don't Open" }).click();
  expect(await ipcCalls(page, "project_trust_set")).toHaveLength(0);
  await banner.getByRole("button", { name: "Trust Project" }).click();
  await dialog.getByRole("button", { name: "Trust Project", exact: true }).click();
  await expect(banner).toContainText("/dev/third");
  expect(await ipcCalls(page, "project_trust_set")).toEqual([{ path: "/dev/other", trusted: true, folder: false }]);
  await banner.getByRole("button", { name: "Trust Project" }).click();
  await expect(dialog).toContainText("/dev/third");
  await dialog.getByRole("button", { name: "Trust Project", exact: true }).click();
  await expect(banner).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("trusted-members.png"), animations: "disabled" });
});
