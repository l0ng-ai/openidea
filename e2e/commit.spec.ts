/**
 * Committing from the Commit tool window. Git is stubbed at the IPC layer; the repository side is
 * covered by `crates/ide-vcs` against real repositories.
 */
import type { Page } from "@playwright/test";
import type { PartialCommitFile } from "../src/bindings";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

/** A repository with a modified tracked file and an untracked one; `vcs_commit` clears both. */
async function stubRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    let committed = false;
    const changes = [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      { path: `${root}/notes.txt`, relPath: "notes.txt", staged: null, unstaged: "untracked", renamedFrom: null },
    ];
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => (committed ? [] : changes);
    h.vcs_stage = () => null;
    h.vcs_unstage = () => null;
    h.vcs_config_get = () => "configured";
    h.vcs_commit_selection_changes = () => [];
    const readText = h.fs_read_text;
    h.fs_read_text = (args) => {
      if (args.path === `${root}/build.gradle.kts`) return "plugins {}\n";
      if (args.path === `${root}/notes.txt`) return "New notes\n";
      return readText?.(args);
    };
    h.vcs_commit = () => {
      committed = true;
      return "2222222";
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

test("⌘K commits the checked changes with the typed message", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const commit = panel.getByRole("button", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });
  // Tracked changes start included; unversioned files start excluded.
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeChecked();
  await expect(changes.getByRole("checkbox", { name: "Include Unversioned Files in commit" })).not.toBeChecked();
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();

  // Committing without a message is refused.
  await commit.click();
  await expect(panel.getByRole("alert")).toHaveText("Specify commit message");
  await expect(message).toBeFocused();
  expect(await ipcCalls(page, "vcs_commit")).toHaveLength(0);

  await message.fill("Return order DTOs from create");
  await commit.click();
  await expect(page.getByText(/1 file committed: Return order DTOs from create/)).toBeVisible();
  const [committed] = await ipcCalls(page, "vcs_commit");
  expect(committed).toMatchObject({ repo: ROOT, message: "Return order DTOs from create" });
  // The commit takes the checked file itself; the index isn't staged beforehand.
  expect((committed!.options as { stage: string[] }).stage).toEqual([`${ROOT}/build.gradle.kts`]);
  expect(await ipcCalls(page, "vcs_stage")).toHaveLength(0);
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});

test("the Commit window gives its message preferred focus", async ({ workbench: page }) => {
  await stubRepository(page);
  const stripe = page.locator('[data-stripe-button="commit"]');
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  if ((await stripe.getAttribute("aria-pressed")) === "true") await stripe.click();
  await expect(panel).toBeHidden();
  await stripe.click();

  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();
  const changes = panel.getByRole("tree", { name: "Changes" });
  await changes.focus();
  await expect(changes).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(message).toBeFocused();
});

test("continuing a resolved revert reviews staged changes and keeps the draft for a retry", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    const handlers = window.__ipc.handlers;
    let stopped = true;
    let configured = false;
    const operation = () => (stopped ? "revert" : null);
    handlers.vcs_roots = () => [{ root, operation: operation(), head: "main", headCommit: "1111111" }];
    handlers.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: operation(),
    });
    handlers.vcs_review_apply_commit = () => ({
      kind: "revert",
      checkpoint: "reviewed-index",
      message: 'Revert "Original work"\n\nThis reverts commit 2222222.',
      paths: [`${root}/build.gradle.kts`],
    });
    handlers.vcs_config_get = ({ key }) =>
      !configured && (key === "user.name" || key === "user.email") ? null : "configured";
    handlers.vcs_set_user_identity = () => {
      configured = true;
      return null;
    };
    handlers.vcs_operation = ({ op }) => {
      const reviewed = op as { options?: { runHooks?: boolean } };
      if (reviewed.options?.runHooks) {
        throw { kind: "invalidInput", message: "A Git hook rejected this commit." };
      }
      stopped = false;
      return null;
    };
    const store = "/src/features/vcs/store.ts";
    const { refreshNow } = await import(/* @vite-ignore */ store);
    await refreshNow();
  }, ROOT);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const proceed = panel.getByRole("button", { name: "Continue", exact: true });
  const review = page.getByRole("dialog", { name: "Continue Revert" });
  const message = review.getByRole("textbox", { name: "Commit message" });
  const author = review.getByRole("textbox", { name: "Author", exact: true });
  const date = review.getByLabel("Author date", { exact: true });
  const signOff = review.getByRole("checkbox", { name: "Sign-off commit" });
  const hooks = review.getByRole("checkbox", { name: "Run Git hooks" });
  const confirm = review.getByRole("button", { name: "Commit and Continue", exact: true });
  await proceed.click();
  await expect(review.getByRole("list", { name: "Staged Changes" }).getByRole("button")).toHaveText("build.gradle.kts");
  await expect(message).toHaveValue('Revert "Original work"\n\nThis reverts commit 2222222.');
  await author.fill("Canceled Author <canceled@example.invalid>");
  await signOff.click();
  await hooks.click();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).toBeHidden();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);
  await proceed.click();
  await expect(author).toHaveValue("");
  await expect(signOff).not.toBeChecked();
  await expect(hooks).toBeChecked();
  await message.fill("Reviewed revert\n\n# Context");
  await author.fill("Review Author <review@example.invalid>");
  await date.fill("2024-06-04T13:20:21");
  await signOff.click();
  await confirm.click();
  const identity = page.getByRole("dialog", { name: "Git User Name Is Not Defined" });
  await identity.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(identity).toBeHidden();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);

  await proceed.click();
  await expect(message).toHaveValue("Reviewed revert\n\n# Context");
  await confirm.click();
  await identity.getByLabel("Name:", { exact: true }).fill("Repo Committer");
  await identity.getByLabel("E-mail:", { exact: true }).fill("committer@example.invalid");
  await identity.getByRole("checkbox", { name: "Set properties globally" }).click();
  await identity.getByRole("button", { name: "Set and Commit" }).click();
  await expect(page.getByText("A Git hook rejected this commit.")).toBeVisible();
  expect(await ipcCalls(page, "vcs_set_user_identity")).toEqual([
    { repo: ROOT, name: "Repo Committer", email: "committer@example.invalid", global: false },
  ]);

  await proceed.click();
  await expect(message).toHaveValue("Reviewed revert\n\n# Context");
  await expect(author).toHaveValue("Review Author <review@example.invalid>");
  await expect(date).toHaveValue("2024-06-04T13:20:21");
  await expect(signOff).toBeChecked();
  await expect(hooks).toBeChecked();
  await hooks.click();
  await confirm.click();
  const expected = (runHooks: boolean) => ({
    repo: ROOT,
    op: {
      op: "continueReviewedApply",
      checkpoint: "reviewed-index",
      message: "Reviewed revert\n\n# Context",
      options: {
        author: "Review Author <review@example.invalid>",
        authorDate: expect.stringMatching(/^2024-06-04T13:20:21[+-]\d{2}:\d{2}$/),
        signOff: true,
        runHooks,
      },
    },
  });
  await expect.poll(() => ipcCalls(page, "vcs_operation")).toMatchObject([expected(true), expected(false)]);
  await expect(proceed).toBeHidden();
});

test("Commit reviews a paused cherry-pick without collecting unrelated changes or other repositories", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    const handlers = window.__ipc.handlers;
    const nested = `${root}/nested`;
    let stopped = true;
    const branch = (repo: string) => ({
      root: repo,
      head: "main",
      headCommit: repo === root && !stopped ? "3333333" : "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: repo === root && stopped ? "cherry-pick" : null,
    });
    const file = (path: string, relPath: string, staged: string | null, unstaged: string | null) => ({
      path,
      relPath,
      staged,
      unstaged,
      renamedFrom: null,
    });
    handlers.vcs_roots = () => [branch(root), branch(nested)];
    handlers.vcs_branch_info = ({ repo }) => branch(String(repo ?? root));
    handlers.vcs_status = () => [
      ...(stopped ? [file(`${root}/build.gradle.kts`, "build.gradle.kts", "modified", null)] : []),
      file(`${root}/local.txt`, "local.txt", null, "modified"),
      file(`${nested}/nested.txt`, "nested.txt", null, "modified"),
    ];
    handlers.vcs_review_apply_commit = () => ({
      kind: "cherry-pick",
      checkpoint: "paused-pick-index",
      message: "Original pick message",
      author: "Original Author <original@example.invalid>",
      paths: [`${root}/build.gradle.kts`],
    });
    handlers.vcs_commit_crlf_paths = ({ paths }) => paths;
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        vcs: { ...settings?.vcs, commit: { ...settings?.vcs?.commit, clearInitialMessage: true } },
      },
    });
    handlers.vcs_operation = () => {
      stopped = false;
      return null;
    };
    const store = "/src/features/vcs/store.ts";
    const { refreshNow } = await import(/* @vite-ignore */ store);
    await refreshNow();
  }, ROOT);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const commit = panel.getByRole("button", { name: "Commit", exact: true });
  const draft = panel.getByRole("textbox", { name: "Commit message" });
  const local = panel.getByRole("checkbox", { name: "Include local.txt in commit" });
  const nested = panel.getByRole("checkbox", { name: "Include nested.txt in commit" });
  const review = page.getByRole("dialog", { name: "Continue Cherry-Pick" });
  const message = review.getByRole("textbox", { name: "Commit message" });
  const author = review.getByRole("textbox", { name: "Author", exact: true });
  await expect(nested).toBeChecked();
  await draft.fill("Unrelated and shared draft");
  await commit.click();
  await expect(page.getByText("Review paused Git operations separately")).toBeVisible();
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
  expect(await ipcCalls(page, "vcs_review_apply_commit")).toEqual([]);
  await nested.click();
  await expect(local).toBeChecked();
  await panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  await options.getByRole("checkbox", { name: "Sign-off commit" }).click();
  await options.getByRole("checkbox", { name: "Run Git hooks" }).click();
  await options.getByRole("textbox", { name: "Author", exact: true }).fill("Panel Author <panel@example.invalid>");
  await page.keyboard.press("Escape");
  await commit.click();
  await expect(message).toHaveValue("Original pick message");
  await expect(author).toHaveValue("Original Author <original@example.invalid>");
  await expect(review.getByRole("list", { name: "Staged Changes" }).getByRole("button")).toHaveText("build.gradle.kts");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveValue("Unrelated and shared draft");
  await local.click();
  await draft.fill("Commit panel draft for the pick");
  await panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  await options.getByRole("textbox", { name: "Author", exact: true }).fill("Panel Author <panel@example.invalid>");
  await page.keyboard.press("Escape");
  await commit.click();
  await expect(message).toHaveValue("Commit panel draft for the pick");
  await expect(author).toHaveValue("Panel Author <panel@example.invalid>");
  await expect(review.getByRole("checkbox", { name: "Sign-off commit" })).toBeChecked();
  await expect(review.getByRole("checkbox", { name: "Run Git hooks" })).not.toBeChecked();
  await message.fill("Confirmed cherry-pick message");
  await review.getByRole("button", { name: "Commit and Continue", exact: true }).click();
  const checks = page.getByRole("dialog", { name: "Commit Checks", exact: true });
  await expect(checks.getByText(/1 selected file has CRLF \(build\.gradle\.kts\)/)).toBeVisible();
  await expect(checks.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);
  expect(await ipcCalls(page, "vcs_commit_crlf_paths")).toMatchObject([
    { repo: ROOT, paths: [`${ROOT}/build.gradle.kts`] },
  ]);
  await checks.getByRole("button", { name: "Commit Anyway", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([
      {
        repo: ROOT,
        op: {
          op: "continueReviewedApply",
          checkpoint: "paused-pick-index",
          message: "Confirmed cherry-pick message",
          options: { author: "Panel Author <panel@example.invalid>", authorDate: null, signOff: true, runHooks: false },
        },
      },
    ]);
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
  await expect(draft).toHaveValue("");
});

test("continuing a resolved operation applies commit modifications to the reviewed staging snapshot", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    const handlers = window.__ipc.handlers;
    const path = `${root}/build.gradle.kts`;
    let stopped = true;
    let formatted = false;
    let analysisRuns = 0;
    const branch = () => ({
      root,
      head: "main",
      headCommit: stopped ? "1111111" : "2222222",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: stopped ? "revert" : null,
    });
    handlers.vcs_roots = () => [branch()];
    handlers.vcs_branch_info = branch;
    handlers.vcs_status = () => [
      {
        path,
        relPath: "build.gradle.kts",
        staged: stopped ? "modified" : null,
        unstaged: "modified",
        renamedFrom: null,
      },
      { path: `${root}/notes.txt`, relPath: "notes.txt", staged: null, unstaged: "modified", renamedFrom: null },
    ];
    const review = () => ({
      kind: "revert",
      checkpoint: formatted ? "formatted-index" : "original-index",
      message: "Revert original change",
      paths: [path],
    });
    handlers.vcs_review_apply_commit = review;
    handlers.vcs_staged_text = () => ({ text: "import unused\nval n=2\n", version: "original-blob" });
    handlers.vcs_file_at = ({ rev }) => (rev === ":0" && formatted ? "val n = 3\n" : "val n = 1\n");
    handlers.vcs_diff_hunks = () => [{ kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1 }];
    handlers.lsp_source_action_text = ({ kind }) =>
      kind === "source.organizeImports"
        ? [{ range: { start: { line: 0, col: 0 }, end: { line: 1, col: 0 } }, new_text: "" }]
        : [{ range: { start: { line: 0, col: 6 }, end: { line: 0, col: 7 } }, new_text: "3" }];
    handlers.lsp_format_text = () => [
      { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 7 } }, new_text: "val n = 3" },
    ];
    handlers.lsp_snapshot_diagnostics = () =>
      analysisRuns++ === 0
        ? [
            {
              range: { start: { line: 0, col: 4 }, end: { line: 0, col: 5 } },
              severity: "warning",
              message: "Warning in the commit snapshot",
              source: "Test analyzer",
            },
          ]
        : [];
    handlers.vcs_format_apply_commit = () => {
      formatted = true;
      return review();
    };
    handlers.vcs_commit_crlf_paths = ({ paths }) => (formatted ? paths : []);
    handlers.vcs_operation = () => {
      stopped = false;
      return null;
    };
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        vcs: {
          ...settings?.vcs,
          commit: { ...settings?.vcs?.commit, reformat: true, optimizeImports: true, cleanup: true, analyzeCode: true },
        },
      },
    });
    const store = "/src/features/vcs/store.ts";
    const { refreshNow } = await import(/* @vite-ignore */ store);
    await refreshNow();
  }, ROOT);

  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const proceed = panel.getByRole("button", { name: "Continue", exact: true });
  await proceed.click();
  const review = page.getByRole("dialog", { name: "Continue Revert" });
  await expect(review).toBeVisible();
  expect(await ipcCalls(page, "vcs_format_apply_commit")).toEqual([]);
  await review.getByRole("button", { name: "Commit and Continue", exact: true }).click();
  const checks = page.getByRole("dialog", { name: "Commit Checks", exact: true });
  await expect(checks.getByText(/1 selected file has CRLF \(build\.gradle\.kts\)/)).toBeVisible();
  await expect(checks.getByText(/1 warning found in 1 file/)).toBeVisible();
  const path = `${ROOT}/build.gradle.kts`;
  expect(await ipcCalls(page, "lsp_source_action_text")).toMatchObject([
    { path, kind: "source.organizeImports", text: "import unused\nval n=2\n" },
    { path, kind: "source.fixAll", text: "val n=2\n" },
  ]);
  expect(await ipcCalls(page, "lsp_format_text")).toMatchObject([{ path, text: "val n=3\n" }]);
  expect(await ipcCalls(page, "lsp_snapshot_diagnostics")).toMatchObject([{ path, text: "val n = 3\n" }]);
  expect(await ipcCalls(page, "vcs_format_apply_commit")).toMatchObject([
    {
      repo: ROOT,
      checkpoint: "original-index",
      edits: [{ path, version: "original-blob", text: "val n = 3\n" }],
    },
  ]);
  expect(await ipcCalls(page, "apply_workspace_edit")).toEqual([]);
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);
  await checks.getByRole("button", { name: "Review", exact: true }).click();
  await expect(checks).toBeHidden();
  await expect(page.getByText("Warning in the commit snapshot", { exact: true })).toBeVisible();
  await expect(page.getByText("Staged (index)", { exact: true }).first()).toBeVisible();
  expect(await ipcCalls(page, "vcs_operation")).toEqual([]);
  await proceed.click();
  await review.getByRole("button", { name: "Commit and Continue", exact: true }).click();
  await checks.getByRole("button", { name: "Commit Anyway", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([{ repo: ROOT, op: { op: "continueReviewedApply", checkpoint: "formatted-index" } }]);
  await expect(proceed).toBeHidden();
});

test("keeps cleanup of selected lines through Commit Anyway and preserves the excluded line", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  const path = `${ROOT}/build.gradle.kts`;
  await page.evaluate(
    async ({ path }) => {
      const handlers = window.__ipc.handlers;
      const head = "top\noriginal left\noriginal right\nend\n";
      const disk = "top\nexcluded edit\nselected edit\nend\n";
      const selected = "top\noriginal left\nselected edit\nend\n";
      const hunk = {
        kind: "modified",
        start: 1,
        lines: 2,
        oldStart: 1,
        oldLines: 2,
        oldText: "original left\noriginal right\n",
      };
      handlers.vcs_file_at = ({ rev }) =>
        rev === "2222222" ? selected.replace("selected edit", "cleaned edit") : head;
      handlers.fs_read_text = () => disk;
      handlers.vcs_diff_hunks = () => [hunk];
      handlers.vcs_preview_partial_commit = ({ file }) => (file as PartialCommitFile).prepared?.text ?? selected;
      handlers.lsp_source_action_text = () => [
        { range: { start: { line: 2, col: 0 }, end: { line: 2, col: 13 } }, new_text: "cleaned edit" },
      ];
      handlers.lsp_snapshot_diagnostics = () => [
        {
          range: { start: { line: 2, col: 0 }, end: { line: 2, col: 0 } },
          severity: "warning",
          message: "Review the cleaned selection",
        },
      ];
      const info = { id: 12, text: disk, version: 2, large: false, readOnly: false, dirty: false };
      handlers.doc_open = () => info;
      handlers.doc_snapshot = () => info;
      handlers.doc_autosave = () => true;
      handlers.doc_close = () => null;
      handlers.apply_workspace_edit = () => null;
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      const { settings } = useProject.getState();
      useProject.setState({
        settings: {
          ...settings,
          vcs: {
            ...settings?.vcs,
            commit: { ...settings?.vcs?.commit, cleanup: true, analyzeCode: true, postponeSlowChecks: false },
          },
        },
      });
      const hunksModule = "/src/features/vcs/hunks.ts";
      const [key] = (await import(/* @vite-ignore */ hunksModule)).hunkKeys(disk, [hunk]);
      const commitModule = "/src/features/vcs/commitStore.ts";
      const { useCommit } = await import(/* @vite-ignore */ commitModule);
      useCommit.setState({
        checks: new Map([
          [path, "hunks"],
          [path.replace("build.gradle.kts", "notes.txt"), "none"],
        ]),
        excludedHunkLines: new Map([[path, new Map([[key, { old: new Set([0]), current: new Set([0]) }]])]]),
      });
    },
    { path },
  );
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Selected lines");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  const before = "top\noriginal left\nselected edit\nend\n";
  const cleaned = "top\noriginal left\ncleaned edit\nend\n";
  await expect(panel.getByText(/1 warning found in 1 file/)).toBeVisible();
  expect(await ipcCalls(page, "lsp_snapshot_diagnostics")).toMatchObject([{ path, text: cleaned }]);
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
  expect(await ipcCalls(page, "apply_workspace_edit")).toEqual([]);
  await panel.getByRole("button", { name: "Commit Anyway", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_commit"))
    .toMatchObject([{ options: { partial: [{ path, prepared: { before, text: cleaned } }] } }]);
  await expect
    .poll(() => ipcCalls(page, "apply_workspace_edit"))
    .toMatchObject([
      {
        edit: {
          files: [
            {
              path,
              version: 2,
              edits: [{ range: { start: { line: 2, col: 0 }, end: { line: 2, col: 13 } }, new_text: "cleaned edit" }],
            },
          ],
        },
      },
    ]);
  expect(await ipcCalls(page, "lsp_source_action_text")).toHaveLength(1);
});

async function stubCommitAnalysis(page: Page) {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    let committed = false;
    const path = `${root}/build.gradle.kts`;
    const h = window.__ipc.handlers;
    const error = {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 4 } },
      severity: "error",
      message: "Unresolved symbol in committed code",
      source: "Test analyzer",
    };
    h.vcs_status = () =>
      committed ? [] : [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: null, renamedFrom: null }];
    h.vcs_branch_info = () => ({ head: "main", headCommit: committed ? "2222222" : "1111111", operation: null });
    h.vcs_commit = () => {
      committed = true;
      return "2222222";
    };
    h.vcs_commit_selection_changes = () => [
      { path: "build.gradle.kts", kind: "modified", oldPath: null, before: "1111111", after: "2222222" },
    ];
    h.vcs_file_at = ({ rev }) =>
      rev === "2222222"
        ? "Committed code() // TODO in commit\n"
        : rev === ":0"
          ? "Selected code()\n"
          : "Original code()\n";
    h.vcs_diff_hunks = () => [
      { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "Original code()\n" },
    ];
    h.lsp_snapshot_diagnostics = ({ text }) =>
      text === "Committed code() // TODO in commit\n"
        ? new Promise((resolve) =>
            window.addEventListener("releaseCommitAnalysis", () => resolve([error]), { once: true }),
          )
        : [error];
    const module = "/src/features/vcs/store.ts";
    await (await import(/* @vite-ignore */ module)).refreshNow();
  }, ROOT);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Check committed code");
  return panel;
}

test("a local commit finishes before background analysis of the committed revision", async ({ workbench: page }) => {
  const panel = await stubCommitAnalysis(page);
  await panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  await expect(options.getByRole("checkbox", { name: "Run advanced checks after commit" })).toBeChecked();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_commit")).toHaveLength(1);
  await expect(panel.getByText("build.gradle.kts", { exact: true })).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "lsp_snapshot_diagnostics"))
    .toMatchObject([{ path: `${ROOT}/build.gradle.kts`, text: "Committed code() // TODO in commit\n" }]);
  await page.evaluate(() => window.dispatchEvent(new Event("releaseCommitAnalysis")));
  await expect(page.getByText("Post-commit checks failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 TODO item in committed changes/)).toBeVisible();
  await page.getByRole("button", { name: "Review TODOs", exact: true }).click();
  const todo = page.getByRole("region", { name: "TODO", exact: true });
  await expect(todo.getByRole("tab", { name: /Committed TODOs/ })).toHaveAttribute("aria-selected", "true");
  await expect(
    todo.getByRole("tree", { name: "TODO items" }).getByText("TODO in commit", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText("Unresolved symbol in committed code", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "vcs_commit_selection_changes")).toMatchObject([{ repo: ROOT, commits: ["2222222"] }]);
});

test("Commit and Push runs code analysis before creating a commit even with background checks enabled", async ({
  workbench: page,
}) => {
  const panel = await stubCommitAnalysis(page);
  await panel.getByRole("button", { name: "Commit and Push…", exact: true }).click();
  await expect(panel.getByText(/1 error found in 1 file/)).toBeVisible();
  expect(await ipcCalls(page, "lsp_snapshot_diagnostics")).toMatchObject([
    { path: `${ROOT}/build.gradle.kts`, text: "Selected code()\n" },
  ]);
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
  expect(await ipcCalls(page, "vcs_commit_selection_changes")).toEqual([]);
});

test("Run Commit Checks reports the selected changes when background checks are enabled", async ({
  workbench: page,
}) => {
  const panel = await stubCommitAnalysis(page);
  await panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  await options.getByRole("button", { name: "Run Commit Checks", exact: true }).click();
  await expect(panel.getByText(/1 error found in 1 file/)).toBeVisible();
  expect(await ipcCalls(page, "lsp_snapshot_diagnostics")).toMatchObject([
    { path: `${ROOT}/build.gradle.kts`, text: "Selected code()\n" },
  ]);
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

test("Commit Options applies a named TODO filter independently of the TODO window", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.evaluate(() => {
    const handlers = window.__ipc.handlers;
    handlers.vcs_file_at = () => "Original\n";
    handlers.fs_read_text = () => "// TODO polish later; FIXME block release\n";
    handlers.vcs_diff_hunks = () => [
      { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "Original\n" },
    ];
  });
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Check release blockers");
  const openOptions = () => panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  const configure = options.getByRole("button", { name: "Configure TODO Filter", exact: true });
  await openOptions();
  await configure.click();
  await page.getByRole("menuitem", { name: "Edit Filters…", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Add TODO Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Add TODO Filter", exact: true });
  const save = filter.getByRole("button", { name: "OK", exact: true });
  await expect(save).toBeDisabled();
  await filter.getByRole("textbox", { name: "Filter name" }).fill("Release blockers");
  await expect(save).toBeDisabled();
  await filter.getByRole("checkbox", { name: "FIXME", exact: true }).check();
  await save.click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();

  if (!(await options.isVisible())) await openOptions();
  await configure.click();
  await page.getByRole("menuitemcheckbox", { name: "Release blockers", exact: true }).click();
  await expect(configure).toHaveText("Release blockers");
  await options.getByRole("button", { name: "Run Commit Checks", exact: true }).click();
  await expect(panel.getByText(/1 TODO item found/)).toBeVisible();
  await panel.getByRole("button", { name: "Review TODOs", exact: true }).click();
  const todoItems = page.getByRole("region", { name: "TODO", exact: true }).getByRole("tree", { name: "TODO items" });
  await expect(todoItems.getByText(/FIXME block release/)).toBeVisible();
  await expect(todoItems.getByText(/TODO polish later/)).toBeHidden();

  const todo = "/src/platform/todoFilterSelection.ts";
  expect(
    await page.evaluate(async (module) => {
      const { todoFilterSelection } = await import(/* @vite-ignore */ module);
      return { commit: todoFilterSelection("commit"), view: todoFilterSelection("view") };
    }, todo),
  ).toEqual({ commit: expect.any(String), view: null });

  await openOptions();
  await configure.click();
  await page.getByRole("menuitemcheckbox", { name: "Show All", exact: true }).click();
  await options.getByRole("button", { name: "Run Commit Checks", exact: true }).click();
  await expect(panel.getByText(/2 TODO items found/)).toBeVisible();
  await panel.getByRole("button", { name: "Review TODOs", exact: true }).click();
  await expect(todoItems.getByText(/TODO polish later/)).toBeVisible();
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

test("the TODO check reports unreadable files and can retry after they become available", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  await page.evaluate(() => {
    const handlers = window.__ipc.handlers;
    handlers.vcs_file_at = () => "Original\n";
    handlers.fs_read_text = () => {
      throw { kind: "io", message: "Fixture file is locked", data: null };
    };
    handlers.vcs_diff_entries = () => [{ mode: "100644", gitlink: null }];
    handlers.vcs_diff_hunks = () => [
      { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "Original\n" },
    ];
  });
  await page.keyboard.press("Meta+k");
  const commit = page.getByRole("region", { name: "Commit", exact: true });
  await commit.getByRole("textbox", { name: "Commit message" }).fill("Check without losing the draft");
  await commit.getByRole("button", { name: "Commit Options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Commit Options", exact: true })
    .getByRole("button", {
      name: "Run Commit Checks",
      exact: true,
    })
    .click();
  await expect(commit.getByText(/Could not check 1 file/)).toBeVisible();
  await expect(commit.getByRole("button", { name: "Commit Anyway", exact: true })).toBeVisible();
  await expect(commit.getByText("Commit checks passed")).toBeHidden();
  await commit.getByRole("button", { name: "Review TODOs", exact: true }).click();
  const todo = page.getByRole("region", { name: "TODO", exact: true });
  const skipped = todo.getByRole("region", { name: "Files Not Checked", exact: true });
  await expect(skipped.getByText("build.gradle.kts", { exact: true })).toBeVisible();
  await expect(skipped.getByText("Fixture file is locked", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    window.__ipc.handlers.fs_read_text = () => "// TODO now readable\n";
  });
  await commit.getByRole("button", { name: "Rerun Commit Checks", exact: true }).click();
  await expect(commit.getByText(/1 TODO item found/)).toBeVisible();
  await expect(commit.getByText(/Could not check 1 file/)).toBeHidden();
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

test("pending TODO review includes every match and keeps the checked text", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.evaluate(() => {
    const handlers = window.__ipc.handlers;
    handlers.vcs_file_at = () => "Original\n";
    handlers.fs_read_text = () => Array.from({ length: 25 }, (_, i) => `// TODO review task ${i + 1}\n`).join("");
    handlers.vcs_diff_hunks = () => [
      { kind: "modified", start: 0, lines: 25, oldStart: 0, oldLines: 1, oldText: "Original\n" },
    ];
  });
  await page.keyboard.press("Meta+k");
  const commit = page.getByRole("region", { name: "Commit", exact: true });
  await commit.getByRole("textbox", { name: "Commit message" }).fill("Keep the checked snapshot");
  await commit.getByRole("button", { name: "Commit Options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Commit Options", exact: true })
    .getByRole("button", { name: "Run Commit Checks", exact: true })
    .click();
  await expect(commit.getByText(/25 TODO items found/)).toBeVisible();
  await page.evaluate(() => {
    window.__ipc.handlers.fs_read_text = () => "Changed after the check\n";
  });
  const reviewButton = commit.getByRole("button", { name: "Review TODOs", exact: true });
  await reviewButton.click();
  const todo = page.getByRole("region", { name: "TODO", exact: true });
  const tab = todo.getByRole("tab", { name: /Commit TODOs.*Keep the checked snapshot/ });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await reviewButton.click();
  await expect(tab).toHaveCount(1);
  const tree = todo.getByRole("tree", { name: "TODO items" });
  await tree.press("End");
  await expect(tree.getByRole("treeitem", { name: /TODO review task 25$/ })).toHaveAttribute("aria-selected", "true");
  const preview = todo.getByRole("region", { name: "Preview", exact: true });
  await expect(preview.getByText(/TODO review task 25/)).toBeVisible();
  await expect(preview.getByText("Changed after the check")).toBeHidden();
  await tab.press("Delete");
  await expect(tab).toBeHidden();
  await expect(todo.getByRole("tab", { name: /Project/ })).toHaveAttribute("aria-selected", "true");
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

test("opening a TODO review from the modal commit leaves the draft available", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: { ...settings, vcs: { ...settings?.vcs, commit: { ...settings?.vcs?.commit, nonModal: false } } },
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_file_at = () => "Original\n";
    handlers.fs_read_text = () => "// TODO from the commit dialog\n";
    handlers.vcs_diff_hunks = () => [
      { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "Original\n" },
    ];
  });

  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Commit Changes", exact: true });
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("Keep this draft");
  await dialog.getByRole("button", { name: "Run Commit Checks", exact: true }).click();
  await dialog.getByRole("button", { name: "Review TODOs", exact: true }).click();
  await expect(dialog).toBeHidden();
  const todo = page.getByRole("region", { name: "TODO", exact: true });
  await expect(todo.getByRole("tree").getByText("TODO from the commit dialog")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(dialog.getByRole("textbox", { name: "Commit message" })).toHaveValue("Keep this draft");
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

async function configureCommitTests(page: Page) {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    const config = {
      id: "npm:test",
      name: "Verification suite",
      kind: "npm",
      command: "npm",
      args: ["test"],
      cwd: root,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: null,
    };
    const handlers = window.__ipc.handlers;
    handlers.run_configs = () => [config];
    handlers.run_apply_settings = ({ configs }) => configs;
    handlers.run_start = ({ onOutput }) => {
      window.addEventListener(
        "finishCommitTests",
        () => {
          window.__ipc.send(onOutput, { kind: "stderr", text: "Verification suite fixture failed\n" });
          window.__ipc.emit({ type: "runExited", run: 75, code: 7 });
        },
        { once: true },
      );
      return { id: 75, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
    };
    handlers.run_stop = ({ id }) => {
      window.__ipc.emit({ type: "runExited", run: Number(id), code: 143 });
      return null;
    };
    const runModule = "/src/features/run/store.ts";
    await (await import(/* @vite-ignore */ runModule)).loadConfigs();
  }, ROOT);

  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Run verification");
  const openOptions = () => panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  await openOptions();
  const toggle = options.getByRole("checkbox", { name: "Run Tests", exact: true });
  await expect(toggle).not.toBeChecked();
  await options.getByRole("button", { name: "Test run configuration" }).click();
  await page.getByRole("option", { name: "Verification suite", exact: true }).click();
  await toggle.check();
  await page.keyboard.press("Escape");
  return { panel, options, openOptions };
}

for (const action of ["Run Commit Checks", "Commit and Push…", "Commit"] as const) {
  test(`${action} runs the selected verification configuration`, async ({ workbench: page }) => {
    const { panel, options, openOptions } = await configureCommitTests(page);
    if (action === "Run Commit Checks") {
      await openOptions();
      await options.getByRole("button", { name: action, exact: true }).click();
    } else {
      await panel.getByRole("button", { name: action, exact: true }).click();
    }

    await expect.poll(() => ipcCalls(page, "run_start")).toMatchObject([{ config: { id: "npm:test" } }]);
    expect(await ipcCalls(page, "vcs_commit")).toHaveLength(action === "Commit" ? 1 : 0);
    const run = page.getByRole("region", { name: "Run", exact: true });
    await expect(run).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event("finishCommitTests")));
    const summary = action === "Commit" ? page : panel;
    await expect(summary.getByText(/Verification suite" exited with code 7/)).toBeVisible();
    await summary.getByRole("button", { name: "Review Run Output", exact: true }).click();
    await expect(run.getByText("Verification suite fixture failed")).toBeVisible();
    expect(await ipcCalls(page, "vcs_commit")).toHaveLength(action === "Commit" ? 1 : 0);
  });
}

test("cancelling commit tests stops the owned run and aborts the commit", async ({ workbench: page }) => {
  const { panel } = await configureCommitTests(page);
  await panel.getByRole("button", { name: "Commit and Push…", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "run_start")).toHaveLength(1);
  await page.getByRole("button", { name: "Background tasks: Running tests for commit" }).click();
  await page.getByRole("button", { name: "Cancel Running tests for commit" }).click();
  await expect.poll(() => ipcCalls(page, "run_stop")).toMatchObject([{ id: 75 }]);
  await expect(panel.getByRole("button", { name: "Commit and Push…", exact: true })).toBeEnabled();
  expect(await ipcCalls(page, "vcs_commit")).toEqual([]);
});

test("turning off default inclusion starts Commit with all files unchecked", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const label = "Include changes in the commit by default";
  await settings.getByRole("textbox", { name: "Search settings" }).fill(label);
  await settings.getByRole("treeitem", { name: "Commit", exact: true }).click();
  const toggle = settings.getByRole("checkbox", { name: label, exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).not.toBeVisible();

  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });
  const tracked = changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" });
  await expect(tracked).toHaveAttribute("aria-checked", "false");
  await expect(changes.getByRole("checkbox", { name: "Include Unversioned Files in commit" })).not.toBeChecked();
  await tracked.click();
  await expect(tracked).toBeChecked();
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Commit the selected file");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_commit")).toHaveLength(1);
  const [committed] = await ipcCalls(page, "vcs_commit");
  expect(committed!.options).toMatchObject({ stage: [`${ROOT}/build.gradle.kts`] });
});

test("the Commit tool window restores the draft and author options for the included changelist", async ({
  workbench: page,
}) => {
  await stubRepository(page);
  await page.evaluate(async (root) => {
    const listsPath = "/src/features/vcs/changelists.ts";
    const { initialChangelists, useChangelists } = await import(/* @vite-ignore */ listsPath);
    const state = initialChangelists();
    state.lists.push({ id: "feature", name: "Feature", comment: "Message from the changelist" });
    state.files = { "build.gradle.kts": state.active, "notes.txt": "feature" };
    useChangelists.setState({ state, root, loaded: true });
    let files = ["build.gradle.kts", "notes.txt"];
    const handlers = window.__ipc.handlers;
    handlers.vcs_status = () =>
      files.map((relPath) => ({
        relPath,
        path: `${root}/${relPath}`,
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      }));
    handlers.vcs_commit = () => {
      files = ["build.gradle.kts"];
      return "2222222";
    };
    const storePath = "/src/features/vcs/store.ts";
    await (await import(/* @vite-ignore */ storePath)).refreshNow();
  }, ROOT);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  const base = panel.getByRole("checkbox", { name: "Include build.gradle.kts in commit" });
  const feature = panel.getByRole("checkbox", { name: "Include notes.txt in commit" });
  const gear = panel.getByRole("button", { name: "Commit Options", exact: true });
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  const author = options.getByRole("textbox", { name: "Author", exact: true });
  const date = options.getByLabel("Author date", { exact: true });
  const baseDate = "2021-05-03T08:30:05";
  const featureDate = "2022-06-04T13:20:21";
  const featureAuthor = "Feature Author <feature@example.test>";
  await expect(base).toBeChecked();
  await expect(feature).not.toBeChecked();
  await message.fill("Default draft");
  await gear.click();
  await author.fill("Default Author <default@example.test>");
  await date.fill(baseDate);
  await page.keyboard.press("Escape");
  await base.click();
  await feature.click();
  await expect(message).toHaveValue("Message from the changelist");
  await message.fill("Feature draft");
  await gear.click();
  await expect(author).toHaveValue("");
  await expect(date).toHaveValue("");
  await author.fill(featureAuthor);
  await date.fill(featureDate);
  await page.keyboard.press("Escape");
  await feature.click();
  await expect(message).toHaveValue("Default draft");
  await gear.click();
  await expect(author).toHaveValue("Default Author <default@example.test>");
  await expect(date).toHaveValue(baseDate);
  await page.keyboard.press("Escape");
  await feature.click();
  await expect(message).toHaveValue("Feature draft");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_commit"))
    .toMatchObject([{ message: "Feature draft", options: { author: featureAuthor, stage: [`${ROOT}/notes.txt`] } }]);
  const [committed] = await ipcCalls(page, "vcs_commit");
  const expectedDate = await page.evaluate((local) => new Date(local).toISOString(), featureDate);
  expect(new Date((committed!.options as { authorDate: string }).authorDate).toISOString()).toBe(expectedDate);
  await expect(message).toHaveValue("Default draft");
});

test("commit message history opens above the message without an empty icon column", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const message = page.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeVisible();
  await page.evaluate((root) => {
    localStorage.setItem(`openidea.vcs.commitMessages:${root}`, JSON.stringify(["Previous commit message"]));
  }, ROOT);
  await message.fill("Draft");
  await page.getByRole("button", { name: "Commit Message History" }).click();

  const menu = page.getByRole("menu", { name: "Recent commit messages" });
  const row = menu.getByRole("menuitem", { name: "Previous commit message" });
  await expect(row).toBeVisible();
  const messageBox = await message.boundingBox();
  const menuBox = await menu.locator("..").boundingBox();
  expect(messageBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThan(messageBox!.y);
  expect(Math.abs(menuBox!.x - messageBox!.x)).toBeLessThan(2);
  await expect(row.locator("span")).toHaveCount(1);
});

test("Amend shows the original author and warns when the committer differs", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    h.vcs_config_get = ({ key }) =>
      key === "user.name" ? "Default Git User" : key === "user.email" ? "default@example.test" : null;
    h.vcs_log = () => [
      {
        id: "1111111",
        shortId: "1111111",
        parents: ["0000000"],
        summary: "Original commit",
        message: "Original commit",
        author: "Original Author",
        email: "original@example.test",
        committer: "Original Committer",
        committerEmail: "committer@example.test",
      },
    ];
    h.vcs_commit_files = () => [];
  });
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const amend = panel.getByRole("checkbox", { name: "Amend", exact: true });
  const authorLink = panel.getByRole("button", { name: "Edit Commit Author", exact: true });
  const author = page
    .getByRole("dialog", { name: "Commit Options", exact: true })
    .getByRole("textbox", { name: "Author", exact: true });
  const warning = panel.getByRole("img", { name: "Committer of the amended commit differs from default", exact: true });

  await panel.getByRole("button", { name: "Commit Options", exact: true }).click();
  await author.fill("Draft Author <draft@example.test>");
  await page.keyboard.press("Escape");
  await expect(authorLink).toHaveText("Draft Author");
  await amend.check();
  await expect(authorLink).toHaveText("Original Author");
  await expect(warning).toBeVisible();
  await amend.uncheck();
  await expect(authorLink).toHaveText("Draft Author");
  await expect(warning).toBeHidden();

  await amend.check();
  await expect(authorLink).toHaveText("Original Author");
  await authorLink.click();
  await expect(author).toBeFocused();
  await expect(author).toHaveValue("Original Author <original@example.test>");
  await author.fill("Edited Author <edited@example.test>");
  await page.keyboard.press("Escape");
  await amend.uncheck();
  await expect(authorLink).toHaveText("Edited Author");

  await amend.check();
  await expect(authorLink).toHaveText("Original Author");
  await panel.getByRole("button", { name: "Amend Commit", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_commit"))
    .toMatchObject([
      {
        repo: ROOT,
        message: "Original commit",
        options: { amend: true, author: "Original Author <original@example.test>" },
      },
    ]);
  await expect(authorLink).toBeHidden();
});

async function stubEarlierAmend(page: Page) {
  await stubRepository(page);
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    const commit = (id: string, parents: string[], subject: string) => ({
      id,
      shortId: id,
      parents,
      summary: subject,
      message: subject,
      author: "Test",
      email: "test@example.test",
      committer: "Test",
      committerEmail: "test@example.test",
    });
    const tip = commit("1111111", ["aaaaaaa"], "Last local commit");
    h.vcs_log = ({ query }) =>
      (query as { firstParent?: boolean }).firstParent
        ? [
            tip,
            commit("aaaaaaa", ["ddddddd"], "Earlier local commit"),
            commit("ddddddd", ["bbbbbbb"], "Improve local docs"),
            commit("bbbbbbb", ["ccccccc"], "Published commit"),
            commit("ccccccc", [], "Before published commit"),
          ]
        : [tip];
    h.vcs_branches = () => [
      { name: "origin/main", remote: true },
      { name: "origin/feature", remote: true },
    ];
    h.vcs_merge_base = () => "bbbbbbb";
    h.vcs_config_get = ({ key }) => (key === "user.name" ? "Test" : "test@example.test");
    h.vcs_commit_files = ({ commit }) => [
      {
        path: commit === "aaaaaaa" ? "earlier.txt" : "latest.txt",
        kind: "added",
        oldPath: null,
      },
    ];
  });
}

test("Amend can select an earlier commit before protected history", async ({ workbench: page }) => {
  await stubEarlierAmend(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const choose = panel.getByRole("button", { name: "Choose Commit to Amend", exact: true });
  const picker = page.getByRole("listbox", { name: "Choose Commit to Amend", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await message.fill("Draft");
  await choose.click();
  const earlier = picker.getByRole("option", { name: "Earlier local commit", exact: true });
  await expect(earlier).toBeVisible();
  await expect(picker.getByText("Published commit", { exact: true })).toHaveCount(0);
  await expect(picker.getByText("Before published commit", { exact: true })).toHaveCount(0);
  await earlier.click();
  await expect(message).toHaveValue("Earlier local commit");
  await expect(panel.getByRole("treeitem", { name: /Earlier local commit 1 file/ })).toBeVisible();
  await expect(panel.getByRole("treeitem", { name: "earlier.txt", exact: true })).toBeVisible();
  await choose.click();
  await picker.getByRole("option", { name: /^Amend Last Commit/ }).click();
  await expect(message).toHaveValue("Last local commit");
  await panel.getByRole("checkbox", { name: "Amend", exact: true }).uncheck();
  await expect(message).toHaveValue("Draft");

  await choose.click();
  await earlier.click();
  await message.fill("Revised earlier commit");
  await panel.getByRole("button", { name: "Amend Commit", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_commit"))
    .toMatchObject([
      {
        repo: ROOT,
        message: "Revised earlier commit",
        options: {
          amend: true,
          amendTarget: {
            commit: "aaaaaaa",
            head: { branch: "main", commit: "1111111" },
            protectedBranches: ["origin/main"],
          },
          stage: [ROOT + "/build.gradle.kts"],
        },
      },
    ]);
  await expect(panel.getByRole("checkbox", { name: "Amend", exact: true })).not.toBeChecked();
});

test("Amend filters commit subjects while loading and supports keyboard selection", async ({ workbench: page }) => {
  await stubEarlierAmend(page);
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    const log = h.vcs_log!;
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    h.test_release_amend_history = () => resolve();
    h.vcs_log = async (args) => {
      if ((args.query as { firstParent?: boolean }).firstParent) await ready;
      return log(args);
    };
  });
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const choose = panel.getByRole("button", { name: "Choose Commit to Amend", exact: true });
  const picker = page.getByRole("listbox", { name: "Choose Commit to Amend", exact: true });
  const search = page.getByRole("textbox", { name: "Search commits", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await message.fill("Draft");

  await choose.press("d");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("d");
  await search.pressSequentially("ocs");
  await expect(page.getByText("Loading commits…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__ipc.handlers.test_release_amend_history?.({}));
  await expect(picker.getByRole("option")).toHaveCount(1);
  const docs = picker.getByRole("option", { name: "Improve local docs", exact: true });
  await expect(docs.locator("mark")).toHaveText("docs");

  await search.fill("published");
  await expect(picker.getByText("No matches", { exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(picker).toBeHidden();
  await expect(choose).toBeFocused();
  await expect(message).toHaveValue("Draft");

  await choose.press("ArrowDown");
  await expect(search).toHaveValue("");
  await search.fill("Last local");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker.getByRole("option", { name: /Amend Last Commit.*Last local commit/ })).toBeVisible();
  await search.fill("local");
  await expect(picker.getByRole("option")).toHaveCount(3);
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await expect(docs).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", (await docs.getAttribute("id"))!);
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(message).toHaveValue("Improve local docs");

  await choose.press("ArrowDown");
  await expect(docs).toHaveAttribute("aria-selected", "true");
});

for (const editDraft of [false, true]) {
  test(`keeping a conflicting Amend ${editDraft ? "preserves a newer draft" : "creates the prepared commit"}`, async ({
    workbench: page,
  }) => {
    await stubEarlierAmend(page);
    await page.evaluate((root) => {
      const h = window.__ipc.handlers;
      h.vcs_commit = () => {
        throw {
          kind: "invalidInput",
          message: "Amending this commit would cause a conflict.",
          data: { type: "amendConflict", commit: "prepared" },
        };
      };
      h.vcs_keep_amend_commit = () => {
        const branch = { head: "main", headCommit: "prepared", operation: null, ahead: 0, behind: 0, upstream: null };
        h.vcs_roots = () => [{ root, ...branch }];
        h.vcs_branch_info = () => branch;
        h.vcs_status = () => [];
        return "prepared";
      };
    }, ROOT);
    await page.keyboard.press("Meta+k");
    const panel = page.getByRole("region", { name: "Commit", exact: true });
    await panel.getByRole("button", { name: "Choose Commit to Amend", exact: true }).click();
    await page.getByRole("option", { name: "Earlier local commit", exact: true }).click();
    const message = panel.getByRole("textbox", { name: "Commit message" });
    await expect(message).toHaveValue("Earlier local commit");
    await panel.getByRole("button", { name: "Amend Commit", exact: true }).click();

    const keep = page.getByRole("button", { name: "Create Amend Commit Anyway", exact: true });
    await expect(keep).toBeVisible();
    expect(await ipcCalls(page, "vcs_keep_amend_commit")).toHaveLength(0);
    if (editDraft) await message.fill("New draft after conflict");
    await keep.click();
    await expect.poll(() => ipcCalls(page, "vcs_keep_amend_commit")).toEqual([{ repo: ROOT, commit: "prepared" }]);
    await expect(page.getByText("Amend commit created", { exact: true })).toBeVisible();
    expect(await ipcCalls(page, "vcs_commit")).toHaveLength(1);
    await expect(message).toHaveValue(editDraft ? "New draft after conflict" : "Earlier local commit");
    await expect(panel.getByRole("checkbox", { name: "Amend", exact: true })).not.toBeChecked();
    if (editDraft)
      await expect
        .poll(() => page.evaluate((root) => localStorage.getItem(`openidea.vcs.commitDraft:${root}`), ROOT))
        .toBe("New draft after conflict");
  });
}

test("the Commit changes toolbar fits a narrow side pane", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(/* @vite-ignore */ path);
    layout.moveToolWindow("commit", "left");
    layout.setToolWindowSize("left", 164);
  });
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const toolbar = panel.getByRole("toolbar", { name: "Changes" });
  await expect(toolbar).toBeVisible();
  const clipped = await toolbar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    return [...bar.querySelectorAll("button")].flatMap((button) => {
      const box = button.getBoundingClientRect();
      return box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1 ? [button.ariaLabel] : [];
    });
  });
  expect(clipped).toEqual([]);
  const push = panel.getByRole("button", { name: "Commit and Push…" });
  const overflow = await push.locator("span").evaluate((label) => label.scrollWidth - label.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await toolbar.getByRole("button", { name: "Collapse All" }).click();
  await expect(panel.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});

test("the commit message uses the configured editor typography", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const message = page.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        editor: {
          ...settings?.editor,
          fontFamily: "Fira Code",
          fallbackFont: "Maple Mono NF CN",
          fontSize: 17,
          lineHeight: 28,
          fontWeight: 500,
        },
      },
    });
  });
  await expect(message).toHaveCSS("font-size", "17px");
  await expect(message).toHaveCSS("line-height", "28px");
  await expect(message).toHaveCSS("font-weight", "500");
  await expect(message).toHaveCSS("font-family", /"Fira Code".*"Maple Mono NF CN"/);
});
