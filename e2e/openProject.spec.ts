/**
 * Closing a project returns to the Welcome screen, and a recent project opens from there into the
 * workbench. The backend's project handling is stubbed at the IPC layer; `crates/ide-host/tests`
 * covers opening and closing real projects.
 */
import { doubleShift, expect, ipcCalls, stubDesktop, test } from "./fixtures";

const BILLING = "/dev/billing";

test("Close Project shows the Welcome screen; a recent project opens from it once trusted", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate((root) => {
    const entry = (name: string, kind: string) => ({
      name,
      path: `${root}/${name}`,
      kind,
      size: 0,
      mtimeMs: null,
      ignored: false,
      excluded: false,
    });
    const h = window.__ipc.handlers;
    h.close_project = () => null;
    h.app_info = () => ({ version: "1.0.0", platform: "macos", configDir: "/Users/dev/.openidea", wayland: false });
    h.recent_projects = () => [
      { path: root, name: "billing", openedAtMs: Date.now() - 3_600_000, branch: "main" },
      { path: "/dev/acme-api", name: "acme-api", openedAtMs: Date.now(), branch: "main" },
    ];
    let trusted = false;
    h.project_trust_status = (args) => ({ root: args.path, trusted, decided: trusted });
    h.project_trust_set = (args) => {
      trusted = Boolean(args.trusted);
      return null;
    };
    h.open_project = (args) => ({
      trusted: true,
      root: args.path,
      name: String(args.path).split("/").pop(),
      isGit: false,
      settings: {},
    });
    h.fs_read_dir = (args) =>
      args.path === root ? [entry("src", "dir"), entry("package.json", "file"), entry("README.md", "file")] : [];
  }, BILLING);

  await doubleShift(page);
  const search = page.getByRole("dialog", { name: "Search Everywhere" });
  await search.getByRole("combobox").fill("Close Project");
  await expect(search.getByRole("option", { name: /^Close Project/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");

  const projects = page.getByRole("region", { name: "Projects" });
  await expect(page.getByRole("tree", { name: "Project" })).toBeHidden();
  await expect(projects.getByRole("option", { name: /^billing/ })).toBeVisible();
  expect(await ipcCalls(page, "close_project")).toHaveLength(1);

  await projects.getByRole("option", { name: /^billing/ }).click();
  // A project not yet trusted asks first.
  const trust = page.getByRole("dialog", { name: "Trust and Open Project?" });
  await expect(trust).toBeVisible();
  expect(await ipcCalls(page, "open_project")).toHaveLength(0);
  await trust.getByRole("button", { name: "Trust Project" }).click();
  await expect(trust).toBeHidden();
  expect(await ipcCalls(page, "project_trust_set")).toEqual([{ path: BILLING, trusted: true, folder: false }]);
  await expect.poll(() => ipcCalls(page, "open_project")).toEqual([{ path: BILLING }]);
  const tree = page.getByRole("tree", { name: "Project" });
  await expect(tree.getByRole("treeitem", { name: /^billing/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "package.json" })).toBeVisible();
});
