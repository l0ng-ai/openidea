import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("shows Update failures from the branch menu even when VCS notifications are muted", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const branch = { head: "main", upstream: "origin/main", behind: 68, ahead: 0, operation: null, headCommit: "c1" };
    const branches = [
      {
        name: "main",
        current: true,
        remote: false,
        upstream: "origin/main",
        behind: 68,
        ahead: 0,
        commit: "c1",
        lastCommitMs: 0,
      },
    ];
    const h = window.__ipc.handlers;
    h.vcs_branch_info = () => branch;
    h.vcs_branches = () => branches;
    h.vcs_roots = () => [{ root, head: "main", headCommit: "c1", operation: null }];
    h.vcs_status = () => [];
    h.vcs_log = () => [];
    h.vcs_tags = () => [];
    h.vcs_config_get = () => null;
    h.vcs_merge_base = () => "c1";
    h.vcs_remote = () => {
      throw {
        kind: "invalid",
        message:
          "The following untracked working tree files would be overwritten by merge: e2e/settingsFormLayout.spec.ts",
      };
    };
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    useProject.setState({
      settings: {
        ...useProject.getState().settings,
        notifications: { groups: { vcs: { display: "none", log: true } } },
      },
    });
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({
      available: true,
      root,
      repo: root,
      roots: [root],
      branch,
      branches,
      branchesLoaded: true,
    });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });
  const branches = page.getByRole("tree", { name: "Branches" });
  await branches.getByRole("treeitem", { name: /main current/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Update", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Update Project", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Update failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/untracked working tree files would be overwritten by merge/)).toBeVisible();
  expect(await ipcCalls(page, "vcs_remote")).toHaveLength(1);
});

test("Update Project wraps long tracking branches and keeps its options reachable", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.setViewportSize({ width: 360, height: 580 });
  const local = "release/" + "InternationalSettlementReconciliation".repeat(3);
  await page.evaluate(async (head) => {
    const root = "/dev/acme-api";
    const branch = { head, upstream: `origin/${head}`, behind: 1, ahead: 1, operation: null, headCommit: "c1" };
    const h = window.__ipc.handlers;
    h.vcs_branch_info = () => branch;
    h.vcs_roots = () => [{ root, head, headCommit: "c1", operation: null }];
    h.settings_set = () => null;
    h.vcs_remote = () => new Promise(() => {});
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root], branch });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.update");
  }, local);

  const dialog = page.getByRole("dialog", { name: "Update Project", exact: true });
  await expect(dialog.getByText(`Update ${local} from origin/${local} (1 incoming)`)).toBeVisible();
  const body = dialog.locator("[data-dialog-body]");
  const width = await body.evaluate((el) => ({ scroll: el.scrollWidth, available: el.clientWidth }));
  expect(width.scroll).toBe(width.available);

  const reset = dialog.getByRole("button", { name: "Reset to the Remote Branch" });
  await expect(reset).toBeVisible();
  expect(
    await reset.evaluate(
      (el) => el.getBoundingClientRect().right <= el.closest('[role="dialog"]')!.getBoundingClientRect().right,
    ),
  ).toBe(true);
  const merge = dialog.getByRole("radio", { name: /^Merge incoming changes/ });
  const rebase = dialog.getByRole("radio", { name: /^Rebase the current branch/ });
  await expect(merge).toBeChecked();
  await merge.press("ArrowDown");
  await expect(rebase).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Don't show again" }).check();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_remote"))
    .toEqual([expect.objectContaining({ op: { op: "pull", rebase: true } })]);
  expect(await ipcCalls(page, "settings_set")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "vcs.git.updateMethod", value: '"rebase"' }),
      expect.objectContaining({ key: "vcs.confirmation.showUpdateOptions", value: "false" }),
    ]),
  );
});
