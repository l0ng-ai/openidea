import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const primary = "/dev/acme-api";
const worker = "/dev/acme-api/worker";
const workerHead = "7".repeat(40);
const message = "Worker change\n\nReapply this change after review.";

async function showUndoMenu(
  page: Page,
  { stagingArea = false, published = false, competingOperation = false, initialCommit = false } = {},
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ primary, worker, workerHead, message, stagingArea, published, competingOperation, initialCommit }) => {
      const h = window.__ipc.handlers;
      const parent = "6".repeat(40);
      let undone = false;
      let primaryMerge = false;
      const branch = (repo: unknown) => ({
        head: repo === worker ? "topic" : "main",
        headCommit: repo === worker ? (undone ? parent : workerHead) : "1".repeat(40),
        operation: repo === primary && primaryMerge ? "merge" : null,
        upstream: null,
        ahead: 0,
        behind: 0,
      });
      h.vcs_roots = () => [primary, worker].map((root) => ({ root, ...branch(root) }));
      h.vcs_branch_info = ({ repo }) => {
        if (repo === worker && competingOperation) primaryMerge = true;
        return branch(repo);
      };
      h.vcs_status = () =>
        undone
          ? [
              {
                path: worker + "/worker.txt",
                relPath: "worker.txt",
                staged: "modified",
                unstaged: null,
                renamedFrom: null,
              },
            ]
          : [];
      h.vcs_branches = ({ repo }) =>
        published && repo === worker
          ? [
              {
                name: "release/main",
                remote: true,
                current: false,
                commit: workerHead,
                upstream: null,
                ahead: 0,
                behind: 0,
              },
            ]
          : [];
      h.vcs_log = ({ repo }) => {
        const { headCommit } = branch(repo);
        const summary = repo === worker ? "Worker change" : "Primary change";
        return [
          {
            id: headCommit,
            shortId: headCommit.slice(0, 8),
            parents: repo === worker && !undone && !initialCommit ? [parent] : [],
            refs: [],
            author: "A",
            email: "a@example.com",
            timeMs: 1000,
            summary,
            message,
          },
        ];
      };
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => [];
      h.vcs_commit_files = () => [{ path: "worker.txt", kind: "modified", oldPath: null }];
      const details = (repo: unknown) => ({
        message,
        containingBranches: published && repo === worker ? ["release/main"] : [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      });
      h.vcs_log_details = ({ repo }) => details(repo);
      h.vcs_log_details_batch = ({ repo, revisions }) => (revisions as string[]).map(() => details(repo));
      h.vcs_undo_commit = () => {
        undone = true;
        return message;
      };

      const projectPath = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const { settings } = useProject.getState();
      useProject.setState({
        settings: { ...settings, vcs: { git: { stagingArea }, commit: { nonModal: true } } },
      });
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root: primary, repo: primary });
      await refreshNow();
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { primary, worker, workerHead, message, stagingArea, published, competingOperation, initialCommit },
  );
  const row = page.getByRole("listbox", { name: "Commits" }).getByRole("option", { name: /Worker change/ });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo Commit…" }).click();
}

test("Undo Commit uses the selected repository even when another repository needs attention", async ({
  workbench: page,
}) => {
  await showUndoMenu(page, { competingOperation: true });
  const lists = page.getByRole("dialog", { name: "Select Target Changelist" });
  await expect(lists).toBeVisible();
  await lists.getByRole("button", { name: "OK" }).click();
  await expect.poll(() => ipcCalls(page, "vcs_undo_commit")).toEqual([{ repo: worker, commit: workerHead }]);
});

test("Undo Commit in staging mode restores the message without a changelist prompt", async ({ workbench: page }) => {
  await showUndoMenu(page, { stagingArea: true });
  await expect.poll(() => ipcCalls(page, "vcs_undo_commit")).toEqual([{ repo: worker, commit: workerHead }]);
  await expect(page.getByRole("dialog", { name: "Select Target Changelist" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/features/vcs/commitStore.ts";
        return (await import(/* @vite-ignore */ path)).useCommit.getState().message;
      }),
    )
    .toBe(message);
});

test("Undo Commit refuses a commit contained in a protected remote branch without an upstream", async ({
  workbench: page,
}) => {
  await showUndoMenu(page, { published: true });
  await expect(page.getByRole("dialog", { name: "Cannot undo commit" })).toContainText("release/main");
  expect(await ipcCalls(page, "vcs_undo_commit")).toHaveLength(0);
});

test("Undo Commit confirms before removing the initial commit in staging mode", async ({ workbench: page }) => {
  await showUndoMenu(page, { stagingArea: true, initialCommit: true });
  const confirm = page.getByRole("dialog", { name: "Undo Commit" });
  await expect(confirm).toContainText("The initial commit will be undone");
  expect(await ipcCalls(page, "vcs_undo_commit")).toHaveLength(0);
  await confirm.getByRole("button", { name: "Undo Commit" }).click();
  await expect.poll(() => ipcCalls(page, "vcs_undo_commit")).toEqual([{ repo: worker, commit: workerHead }]);
});
