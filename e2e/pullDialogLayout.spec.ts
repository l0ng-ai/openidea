import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Pull fits the remote branch picker and keeps flags accessible in a narrow window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 380, height: 580 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/checkout-reconciliation";
    const second = `${root}/billing-and-transaction-settlement`;
    const branch = {
      head: "main",
      upstream: "origin/main",
      headCommit: "c1",
      behind: 1,
      ahead: 0,
      operation: null,
    };
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [root, second].map((root) => ({ root, ...branch }));
    h.vcs_branch_info = () => branch;
    h.vcs_status = () => [];
    h.vcs_log = () => [];
    h.vcs_remotes = () => [
      { name: "origin", url: "/git/checkout-reconciliation.git" },
      { name: "settlement-integration", url: "/git/settlement.git" },
    ];
    h.vcs_branches = () =>
      ["origin/main", "origin/release/month-end-international-settlement-reconciliation"].map((name) => ({
        name,
        commit: "c1",
        current: false,
        remote: true,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      }));
    h.vcs_remote = () => new Promise(() => {});
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: second, roots: [root, second], branch });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.pull");
  });

  const dialog = page.getByRole("dialog", { name: "Pull to main" });
  const branch = dialog.getByRole("button", { name: "Remote branch" });
  await expect(branch).toHaveText("main");
  const body = dialog.locator("[data-dialog-body]");
  await expect.poll(() => branch.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(250);
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);

  await branch.press("s");
  await page.getByRole("option", { name: "release/month-end-international-settlement-reconciliation" }).click();
  await expect(branch).toContainText("month-end-international-settlement-reconciliation");

  const modify = dialog.getByRole("button", { name: "Modify options" });
  await modify.press("Enter");
  await page.getByRole("menuitemcheckbox", { name: "--ff-only" }).click();
  await expect(dialog.locator("code", { hasText: "--ff-only" })).toBeVisible();
  await modify.press("Enter");
  await expect(page.getByRole("menuitemcheckbox", { name: "--ff-only" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "--no-commit" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(modify).toBeFocused();
  await dialog.getByRole("button", { name: "Pull", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_remote"))
    .toMatchObject([
      {
        repo: "/dev/checkout-reconciliation/billing-and-transaction-settlement",
        op: {
          op: "pullFrom",
          remote: "origin",
          branches: ["release/month-end-international-settlement-reconciliation"],
          rebase: false,
          options: { ffOnly: true },
        },
      },
    ]);
});
