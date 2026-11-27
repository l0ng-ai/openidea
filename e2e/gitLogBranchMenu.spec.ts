import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openGitLog(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const primary = "/dev/acme-api";
    const linked = "/dev/acme-web";
    const tip = "1".repeat(40);
    const h = window.__ipc.handlers;
    h.vcs_roots = () =>
      [
        { root: primary, head: "main" },
        { root: linked, head: "release" },
      ].map((repo) => ({ ...repo, operation: null, headCommit: tip }));
    h.vcs_branch_info = ({ repo }) => ({
      head: repo === linked ? "release" : "main",
      headCommit: tip,
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    const refs = (repo: unknown) => (repo === linked ? ["origin/dev", "topic", "release"] : ["origin/other"]);
    h.vcs_branches = ({ repo }) =>
      refs(repo).map((name) => ({
        name,
        commit: tip,
        remote: name.startsWith("origin/"),
        current: name === "release",
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      }));
    h.vcs_log = ({ repo }) => {
      const summary = repo === linked ? "Linked repository commit" : "Primary repository commit";
      return [
        {
          id: tip,
          shortId: tip.slice(0, 8),
          parents: [],
          refs: refs(repo),
          author: "A",
          email: "a@example.com",
          timeMs: 0,
          summary,
          message: summary,
        },
      ];
    };
    h.vcs_log_refs = () => ({});
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map(() => ({
        message: "Linked repository commit",
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    h.vcs_commit_files = () => [];
    h.vcs_config_get = () => null;
    h.vcs_tags = () => [];
    h.vcs_status = () => [];
    h.vcs_checkout = () => ({ kind: "done" });
    h.vcs_create_branch = () => ({ checkout: { kind: "done" }, created: { tip: "1111111", previousTip: null } });
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root: primary, repo: primary });
    await refreshNow();
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });
}

test("opens a commit's branch menu and acts in its linked repository", async ({ workbench: page }) => {
  await openGitLog(page);
  await page.getByRole("option", { name: /Linked repository commit/ }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu.getByRole("menuitem", { name: "Branch 'origin/other'" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Branch 'origin/dev'" }).hover();
  await expect(page.getByRole("menuitem", { name: "Pull into 'release' Using Rebase" })).toBeVisible();
  const newBranch = page.getByRole("menuitem", { name: "New Branch from 'origin/dev'…" });
  await newBranch.click();
  const dialog = page.getByRole("dialog", { name: "Create New Branch from origin/dev" });
  await dialog.getByRole("textbox", { name: "New branch name:" }).fill("test-branch");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_create_branch"))
    .toMatchObject([{ repo: "/dev/acme-web", name: "test-branch", start: "refs/remotes/origin/dev", checkout: true }]);
});

test("checks out either a local branch or the detached revision from a commit", async ({ workbench: page }) => {
  await openGitLog(page);
  const linked = page.getByRole("option", { name: /Linked repository commit/ });
  await linked.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Checkout", exact: true }).hover();
  const branch = page.getByRole("menuitem", { name: "topic", exact: true });
  await expect(branch).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "release", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "origin/dev", exact: true })).toHaveCount(0);
  await branch.click();
  await linked.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Checkout", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Revision '11111111'", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_checkout"))
    .toMatchObject([
      { repo: "/dev/acme-web", branch: "refs/heads/topic" },
      { repo: "/dev/acme-web", branch: `${"1".repeat(40)}^{commit}` },
    ]);

  await page.getByRole("option", { name: /Primary repository commit/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Checkout Revision '11111111'", exact: true })).toBeVisible();
});
