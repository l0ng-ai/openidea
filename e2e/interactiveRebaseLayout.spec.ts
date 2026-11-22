import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function showLog(page: Page, scenario: "synthetic" | "updateRefs" | "amend" | "edit") {
  const first = "Keep regional settlement references stable when reconciling delayed ledger updates";
  const amend = scenario === "amend";
  const second = amend ? `amend! ${first}` : "Add settlement summary";
  await stubDesktop(page);
  await page.evaluate(
    async ({ first, second, scenario, amend }) => {
      const root = "/dev/acme-api";
      const id = (n: string) => n.repeat(40);
      const commits = [
        { id: id("c"), shortId: "cccccccc", parents: [id("b")], summary: second, timeMs: 1795100200000 },
        { id: id("b"), shortId: "bbbbbbbb", parents: [id("a")], summary: first, timeMs: 1795100100000 },
      ].map((commit) => ({
        ...commit,
        refs: [],
        author: "Sam Rivera",
        email: "sam@example.com",
        message: commit.summary + "\n\nKeep the audit trail linked to the settlement job.",
      }));
      const h = window.__ipc.handlers;
      let rebasing = false;
      let continues = 0;
      h.vcs_roots = () => [{ root, operation: rebasing ? "rebase" : null, head: "main", headCommit: id("c") }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: id("c"),
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: rebasing ? "rebase" : null,
      });
      h.vcs_branches = () => [];
      h.vcs_status = () => [];
      h.vcs_log = () => commits;
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => ["Sam Rivera <sam@example.com>"];
      h.vcs_config_get = () => null;
      h.vcs_config_get_bool = ({ key }) =>
        key === "rebase.updateRefs" ? scenario === "updateRefs" || scenario === "edit" : null;
      h.vcs_commit_files = () => [];
      h.vcs_commit_selection_changes = ({ commits }) =>
        (commits as string[]).map((commit) => ({
          path: commit === id("b") ? "refs.txt" : "summary.txt",
          kind: "added",
          after: commit,
          before: null,
          oldPath: null,
        }));
      h.vcs_log_details_batch = () => [];
      if (scenario !== "synthetic") {
        h.vcs_rebase_with_editor = ({ onEdit, operation }) => {
          if ((operation as { kind: string }).kind === "continue") {
            if (++continues === 1) {
              return new Promise<null>((_, reject) => {
                h.vcs_rebase_editor_reply = () => {
                  reject({ kind: "cancelled", message: "cancelled" });
                  return null;
                };
                window.__ipc.send(onEdit, {
                  index: 1,
                  edit: { kind: "message", text: second, plan: null },
                });
              });
            }
            if (continues === 3) rebasing = false;
            return null;
          }
          return new Promise<null>((resolve) => {
            h.vcs_rebase_editor_reply = ({ reply }) => {
              rebasing = scenario === "edit" && !!reply;
              resolve(null);
              return null;
            };
            const [newer, older] = commits;
            const reference = "refs/heads/review";
            const row = (commit: (typeof commits)[number], line: number) => ({
              ...commit,
              kind: "commit",
              action: "pick",
              revision: commit.shortId,
              line,
            });
            window.__ipc.send(onEdit, {
              index: 1,
              edit: amend
                ? {
                    kind: "plan",
                    text: `pick ${older!.shortId}\nfixup -C ${newer!.shortId}\n`,
                    plan: [row(older!, 0), { ...row(newer!, 1), action: "fixup", fixupMessage: "replace" }],
                  }
                : {
                    kind: "plan",
                    text: `pick ${older!.shortId}\nupdate-ref ${reference}\npick ${newer!.shortId}\n`,
                    plan: [row(older!, 0), { kind: "updateRef", line: 1, reference }, row(newer!, 2)],
                  },
            });
          });
        };
      }
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root, roots: [root], repo: root, branchesLoaded: true });
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { first, second, scenario, amend },
  );
  return { first, second };
}

async function withCommitMenu(page: Page, summary: string) {
  const log = page.getByRole("listbox", { name: "Commits" });
  await log
    .getByRole("option", { name: new RegExp(summary) })
    .filter({ hasNotText: `amend! ${summary}` })
    .click({ button: "right" });
}

async function openLogRebase(page: Page, scenario: "synthetic" | "updateRefs" | "amend" | "edit") {
  const { first, second } = await showLog(page, scenario);
  await withCommitMenu(page, first);
  await page.getByRole("menuitem", { name: /Interactively Rebase from Here/ }).click();
  return { first, second };
}

async function publishToProtectedBranch(page: Page, commit: string) {
  await page.evaluate((commit) => {
    const h = window.__ipc.handlers;
    h.vcs_branches = () => [
      {
        name: "release/main",
        remote: true,
        current: false,
        commit,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      },
    ];
    h.vcs_log_details = ({ revision }) => ({
      message: "Fixture",
      containingBranches: revision === commit ? ["release/main"] : [],
      signature: "N",
      signer: "",
      key: "",
      fingerprint: "",
    });
  }, commit);
}

for (const [menu, title] of [
  [/^Edit Commit Message/, "Cannot edit commit message"],
  [/^Interactively Rebase from Here/, "Cannot rebase"],
  [/^Drop Commits$/, "Cannot drop commit"],
] as const) {
  test(`${title} when the oldest affected commit is on a protected remote without an upstream`, async ({
    workbench: page,
  }) => {
    const { first } = await showLog(page, "synthetic");
    const oldest = "b".repeat(40);
    await publishToProtectedBranch(page, oldest);
    await withCommitMenu(page, first);
    await page.getByRole("menuitem", { name: menu }).click();
    await expect(page.getByRole("dialog", { name: title })).toContainText("release/main");
    expect(await ipcCalls(page, "vcs_log_details")).toContainEqual({ repo: "/dev/acme-api", revision: oldest });
  });
}

test("Edit Commit Message permits a newer local commit above the protected tip", async ({ workbench: page }) => {
  const { second } = await showLog(page, "synthetic");
  await publishToProtectedBranch(page, "b".repeat(40));
  await withCommitMenu(page, second);
  await page.getByRole("menuitem", { name: /^Edit Commit Message/ }).click();
  await expect(page.getByRole("dialog", { name: "Edit Commit Message", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "vcs_log_details")).toContainEqual({ repo: "/dev/acme-api", revision: "c".repeat(40) });
});

test("Edit Commit Message keeps the warning for a published commit on an unprotected upstream", async ({
  workbench: page,
}) => {
  const { second } = await showLog(page, "synthetic");
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    const branchInfo = h.vcs_branch_info!;
    h.vcs_branch_info = async (args) => ({ ...((await branchInfo(args)) as object), upstream: "origin/topic" });
    h.vcs_branches = () => [
      {
        name: "origin/topic",
        remote: true,
        current: false,
        commit: "c".repeat(40),
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      },
    ];
  });
  await withCommitMenu(page, second);
  await page.getByRole("menuitem", { name: /^Edit Commit Message/ }).click();
  const warning = page.getByRole("dialog").filter({ hasText: "already pushed to origin/topic" });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Edit Commit Message", exact: true })).toBeVisible();
});

test("Edit Commit Message refuses a commit published while the dialog was open", async ({ workbench: page }) => {
  const { second } = await showLog(page, "synthetic");
  await withCommitMenu(page, second);
  await page.getByRole("menuitem", { name: /^Edit Commit Message/ }).click();
  const editor = page.getByRole("dialog", { name: "Edit Commit Message", exact: true });
  await editor.getByRole("textbox", { name: "Edit message for commit cccccccc by Sam Rivera" }).fill("New message");
  await publishToProtectedBranch(page, "c".repeat(40));
  await editor.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("dialog", { name: "Cannot edit commit message" })).toContainText("release/main");
  expect(await ipcCalls(page, "vcs_reword")).toHaveLength(0);
});

test("Edit Commit Message refuses a rewrite prepared for another branch", async ({ workbench: page }) => {
  const { second } = await showLog(page, "synthetic");
  await withCommitMenu(page, second);
  await page.getByRole("menuitem", { name: /^Edit Commit Message/ }).click();
  const editor = page.getByRole("dialog", { name: "Edit Commit Message", exact: true });
  await editor.getByRole("textbox", { name: "Edit message for commit cccccccc by Sam Rivera" }).fill("New message");
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    const branchInfo = h.vcs_branch_info!;
    h.vcs_branch_info = async (args) => ({ ...((await branchInfo(args)) as object), head: "another-branch" });
  });
  await editor.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("dialog", { name: "Cannot edit commit message" })).toContainText("The branch changed");
  expect(await ipcCalls(page, "vcs_reword")).toHaveLength(0);
});

test("Undo after reword refuses to move a rewrite that has been published", async ({ workbench: page }) => {
  const { second } = await showLog(page, "synthetic");
  const before = "c".repeat(40);
  const after = "d".repeat(40);
  await page.evaluate(
    ({ before, after }) => {
      const h = window.__ipc.handlers;
      const log = h.vcs_log!;
      h.vcs_reword = () => ({ before, after });
      h.vcs_log = (args) =>
        (args.query as { range?: string }).range === `${before}..${after}` ? [{ id: after }] : log(args);
    },
    { before, after },
  );
  await withCommitMenu(page, second);
  await page.getByRole("menuitem", { name: /^Edit Commit Message/ }).click();
  const editor = page.getByRole("dialog", { name: "Edit Commit Message", exact: true });
  await editor.getByRole("textbox", { name: "Edit message for commit cccccccc by Sam Rivera" }).fill("New message");
  await editor.getByRole("button", { name: "OK" }).click();
  const edited = page.getByRole("status").filter({ hasText: "Commit message of cccccccc changed" });
  await expect(edited).toBeVisible();
  await publishToProtectedBranch(page, after);
  await edited.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Undo failed" })).toContainText("release/main");
  expect(await ipcCalls(page, "vcs_restore_head")).toHaveLength(0);
});

test("Interactive rebase keeps commit messages and plan controls usable at narrow widths", async ({
  workbench: page,
}) => {
  const { first, second } = await openLogRebase(page, "synthetic");
  const dialog = page.getByRole("dialog", { name: /Rebasing 2 commits/ });
  await expect(dialog).toBeVisible();
  const changes = dialog.getByRole("tree", { name: "Changed files" });
  await expect(changes.getByRole("treeitem", { name: "refs.txt" })).toBeVisible();
  await changes.getByRole("treeitem", { name: "refs.txt" }).click();
  await expect(dialog.getByRole("button", { name: "Show Diff", exact: true })).toBeEnabled();

  await page.setViewportSize({ width: 440, height: 640 });
  const list = dialog.getByRole("grid", { name: "Commits to rebase" });
  const originalRows = list.getByRole("row");
  await dialog.getByRole("button", { name: "Action for bbbbbbbb" }).click();
  await page.getByRole("option", { name: "Reword", exact: true }).click();
  const reword = dialog.getByRole("textbox", { name: "New message for bbbbbbbb" });
  await expect(reword).toHaveValue(first + "\n\nKeep the audit trail linked to the settlement job.");
  await dialog.getByRole("button", { name: "Changed files", exact: true }).click();
  const compactChanges = page.getByRole("dialog", { name: "Changed files", exact: true });
  await expect(compactChanges.getByRole("treeitem", { name: "refs.txt" })).toBeVisible();
  await compactChanges.getByRole("button", { name: "Close", exact: true }).click();
  const editor = (await reword.boundingBox())!;
  expect(editor.width).toBeGreaterThan(260);
  expect(editor.height).toBeGreaterThan(160);

  const divider = dialog.getByRole("separator", { name: "Resize rebase panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const start = dialog.getByRole("button", { name: "Start Rebasing" });
  await expect(start).toBeDisabled();
  const message = "Keep settlement references stable\n\nPreserve the audit trail.";
  await reword.fill(message);
  await expect(start).toBeEnabled();

  await dialog.getByRole("button", { name: "Move Down" }).click();
  await expect(originalRows.first()).toContainText(second);
  await expect(reword).toHaveValue(message);
  await originalRows
    .first()
    .getByRole("button", { name: new RegExp(second) })
    .click();
  const details = dialog.getByRole("region", { name: "Commit details" });
  await expect(details).toContainText("Keep the audit trail linked to the settlement job.");
  await expect(changes.getByRole("treeitem", { name: "summary.txt" })).toBeVisible();
  await expect(changes.getByRole("treeitem", { name: "refs.txt" })).toHaveCount(0);

  await page.setViewportSize({ width: 1120, height: 760 });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(details).toContainText(second);
  await originalRows
    .last()
    .getByRole("button", { name: new RegExp(message.split("\n", 1)[0]!) })
    .click({
      modifiers: ["Shift"],
    });
  await expect(list.getByRole("row", { selected: true })).toHaveCount(2);
  await expect(changes.getByRole("treeitem", { name: "summary.txt" })).toBeVisible();
  await expect(changes.getByRole("treeitem", { name: "refs.txt" })).toBeVisible();
  await dialog.getByRole("button", { name: "Selected Commit Actions" }).click();
  await page.getByRole("option", { name: "Drop", exact: true }).click();
  await expect(list.getByRole("button", { name: /Action for/ }).filter({ hasText: "Drop" })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(list.getByRole("button", { name: /Action for/ }).filter({ hasText: "Drop" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const confirmCancel = page.getByRole("dialog", { name: "Cancel Rebase" });
  await confirmCancel.getByRole("button", { name: "Continue Editing" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmCancel.getByRole("button", { name: "Discard Changes" }).click();
  await expect(dialog).toBeHidden();
});

test("Interactive rebase from Git Log preserves Git's ref updates when configured", async ({ workbench: page }) => {
  await openLogRebase(page, "updateRefs");
  const plan = page.getByRole("dialog", { name: "Edit Git Rebase Plan" });
  const update = plan.getByRole("row").filter({ hasText: "refs/heads/review" });
  await expect(update).toBeVisible();
  expect(await ipcCalls(page, "vcs_rebase_with_editor")).toMatchObject([
    { repo: "/dev/acme-api", operation: { kind: "start", upstream: "a".repeat(40) } },
  ]);
  await update.getByRole("button").click();
  await plan.getByRole("button", { name: "Move Down" }).click();
  await expect(plan.getByRole("row").last()).toContainText("refs/heads/review");
  await plan.getByRole("button", { name: "Start Rebasing" }).click();
  await expect(plan).toBeHidden();
  expect(await ipcCalls(page, "vcs_rebase_editor_reply")).toMatchObject([
    { reply: { text: "pick bbbbbbbb\npick cccccccc\nupdate-ref refs/heads/review\n" } },
  ]);
});

test("Interactive rebase from Git Log displays and edits Git's amend fixup", async ({ workbench: page }) => {
  const { second } = await openLogRebase(page, "amend");
  const plan = page.getByRole("dialog", { name: "Edit Git Rebase Plan" });
  const fixup = plan.getByRole("button", { name: "Action for cccccccc" });
  await expect(fixup).toHaveText("Fixup (Replace)");
  await plan.getByRole("button", { name: new RegExp(second) }).click();
  await expect(plan.getByRole("region", { name: "Commit details" })).toContainText(
    "Keep the audit trail linked to the settlement job.",
  );
  await expect(plan.getByRole("region", { name: "Commit details" })).not.toContainText(second);
  await fixup.click();
  await page.getByRole("option", { name: "Fixup (Edit)", exact: true }).click();
  await expect(fixup).toHaveText("Fixup (Edit)");
  await plan.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(fixup).toHaveText("Fixup (Replace)");
  await plan.getByRole("button", { name: "Redo", exact: true }).click();
  await plan.getByRole("button", { name: "Start Rebasing" }).click();
  await expect(plan).toBeHidden();
  expect(await ipcCalls(page, "vcs_rebase_editor_reply")).toMatchObject([
    { reply: { text: "pick bbbbbbbb\nfixup -c cccccccc\n" } },
  ]);
});

test("Paused rebase exposes its controls after a second stop and a cancelled message", async ({ workbench: page }) => {
  await openLogRebase(page, "edit");
  const plan = page.getByRole("dialog", { name: "Edit Git Rebase Plan" });
  await plan.getByRole("button", { name: "Action for bbbbbbbb" }).click();
  await page.getByRole("option", { name: "Stop to Edit", exact: true }).click();
  await plan.getByRole("button", { name: "Start Rebasing" }).click();

  const editing = page.getByRole("status").filter({ hasText: "Rebase stopped for editing" });
  await expect(editing.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
  await editing.getByRole("button", { name: "Continue", exact: true }).click();
  const message = page.getByRole("dialog", { name: "Edit Commit Message" });
  await message.getByRole("button", { name: "Cancel", exact: true }).click();
  const paused = page.getByRole("status").filter({ hasText: "Rebase paused" });
  await paused.getByRole("button", { name: "Continue", exact: true }).click();
  await editing.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: "Rebase continued" })).toBeVisible();
  await expect(editing).toBeHidden();
  await expect(paused).toBeHidden();
  const continues = (await ipcCalls(page, "vcs_rebase_with_editor")).slice(1);
  expect(continues).toHaveLength(3);
  expect(continues.every((call) => call.repo === "/dev/acme-api")).toBe(true);
});

test("Abort Rebase confirms the repository and targets the rebase that produced the notice", async ({
  workbench: page,
}) => {
  const root = "/dev/acme-api";
  const nested = "/dev/acme-api/worker";
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, nested }) => {
      const h = window.__ipc.handlers;
      const rebasing = new Set([root, nested]);
      const branch = (repo: string) => ({
        head: "topic",
        headCommit: "a".repeat(40),
        operation: rebasing.has(repo) ? "rebase" : null,
        upstream: null,
        ahead: 0,
        behind: 0,
      });
      h.vcs_roots = () => [
        { root, ...branch(root) },
        { root: nested, ...branch(nested) },
      ];
      h.vcs_branch_info = ({ repo }) => branch((repo as string | null) ?? root);
      h.vcs_status = () => [
        { path: root + "/work.txt", relPath: "work.txt", staged: null, unstaged: "conflicted", renamedFrom: null },
      ];
      h.vcs_operation = ({ repo }) => {
        rebasing.delete(repo as string);
        return null;
      };
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root, roots: [root, nested], repo: root });
      await refreshNow();
    },
    { root, nested },
  );
  const abort = page
    .getByRole("group", { name: "Merge conflicts" })
    .getByRole("button", { name: "Abort Rebase", exact: true });
  const confirmation = page.getByRole("dialog", { name: "Abort Rebase" });
  await abort.click();
  await expect(confirmation.getByText("Abort rebase in acme-api?")).toBeVisible();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);

  await page.evaluate(async (nested) => {
    const vcsPath = "/src/features/vcs/store.ts";
    const { selectRepo, refreshNow } = await import(/* @vite-ignore */ vcsPath);
    await selectRepo(nested);
    window.__ipc.handlers.vcs_status = () => [];
    await refreshNow();
  }, nested);
  const resolved = page.getByRole("status").filter({ hasText: "All conflicts resolved" });
  await resolved.getByRole("button", { name: "Abort Rebase", exact: true }).click();
  await expect(confirmation.getByText("Abort rebase in acme-api?")).toBeVisible();
  await confirmation.getByRole("button", { name: "Abort", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([{ repo: root, op: { op: "abort", expected: "rebase" } }]);
  await expect(abort).toBeVisible();
});
