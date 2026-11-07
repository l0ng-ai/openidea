/**
 * Committing from the Commit tool window. Git is stubbed at the IPC layer; the repository side is
 * covered by `crates/ide-vcs` against real repositories.
 */
import type { Page } from "@playwright/test";
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
  expect(await ipcCalls(page, "vcs_commit")).toHaveLength(0);

  await message.fill("Return order DTOs from create");
  await commit.click();
  await expect(page.getByText(/1 file committed: Return order DTOs from create/)).toBeVisible();
  const [committed] = await ipcCalls(page, "vcs_commit");
  expect(committed).toMatchObject({ repo: ROOT, message: "Return order DTOs from create" });
  const staged = (await ipcCalls(page, "vcs_stage")).flatMap((a) => a.paths as string[]);
  expect(staged).toEqual([`${ROOT}/build.gradle.kts`]);
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});

async function stubAi(page: Page) {
  await page.evaluate(() => {
    const h = window.__ipc.handlers;
    h.vcs_commit_ai_settings = () => ({
      config: { baseUrl: "http://127.0.0.1:1234/v1", model: "test-model" },
      hasApiKey: false,
    });
    h.vcs_file_at = () => "old line\n";
    h.fs_read_text = () => "new line\n";
    h.vcs_commit_ai_read_text = (args) => (args.revision === "HEAD" ? "old line\n" : "new line\n");
    h.vcs_diff_hunks = () => [
      { start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "old line\n", kind: "modified" },
    ];
    h.vcs_generate_commit_message = () => "更新构建配置\n\n- 调整构建脚本中的配置";
  });
}

test("AI generates a Chinese draft from checked changes without committing", async ({ workbench: page }) => {
  await stubRepository(page);
  await stubAi(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeVisible();
  if (process.env.OPENIDEA_AI_EVIDENCE) {
    await panel.screenshot({ path: `${process.env.OPENIDEA_AI_EVIDENCE}/initial.png`, animations: "disabled" });
  }
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Specify commit message");
  await panel.getByRole("button", { name: "Generate Commit Message with AI" }).click();
  await expect(message).toHaveValue("更新构建配置\n\n- 调整构建脚本中的配置");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(message).not.toHaveAttribute("aria-invalid", "true");
  const [request] = await ipcCalls(page, "vcs_generate_commit_message");
  expect(request!.diff).toContain("build.gradle.kts");
  expect(request!.diff).not.toContain("notes.txt");
  expect(await ipcCalls(page, "vcs_stage")).toHaveLength(0);
  expect(await ipcCalls(page, "vcs_commit")).toHaveLength(0);
  if (process.env.OPENIDEA_AI_EVIDENCE) {
    await panel.screenshot({ path: `${process.env.OPENIDEA_AI_EVIDENCE}/generated.png`, animations: "disabled" });
  }
});

test("AI asks before replacing a draft and keeps it on request failure", async ({ workbench: page }) => {
  await stubRepository(page);
  await stubAi(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await message.fill("my original draft");
  await panel.getByRole("button", { name: "Generate Commit Message with AI" }).click();
  const confirmation = page.getByRole("dialog", { name: "Replace commit message?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(message).toHaveValue("my original draft");
  expect(await ipcCalls(page, "vcs_generate_commit_message")).toHaveLength(0);
  await page.evaluate(() => {
    window.__ipc.handlers.vcs_generate_commit_message = () => {
      throw { kind: "protocol", message: "AI service returned HTTP 401" };
    };
  });
  await panel.getByRole("button", { name: "Generate Commit Message with AI" }).click();
  await page
    .getByRole("dialog", { name: "Replace commit message?" })
    .getByRole("button", { name: "Generate and Replace" })
    .click();
  await expect(panel.getByRole("alert")).toContainText("401");
  await expect(message).toHaveValue("my original draft");
});

test("AI generation can be cancelled before applying a late response", async ({ workbench: page }) => {
  await stubRepository(page);
  await stubAi(page);
  await page.evaluate(() => {
    let respond: ((value: string) => void) | undefined;
    window.__ipc.handlers.vcs_generate_commit_message = () =>
      new Promise<string>((resolve) => {
        respond = resolve;
      });
    window.__ipc.handlers.cancel_request = () => {
      respond?.("late response");
      return null;
    };
  });
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("button", { name: "Generate Commit Message with AI" }).click();
  await expect(panel.getByRole("status")).toHaveText("Generating commit message…");
  await expect(panel.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await expect.poll(async () => (await ipcCalls(page, "vcs_generate_commit_message")).length).toBe(1);
  await panel.getByRole("button", { name: "Cancel Commit Message Generation" }).click();
  await expect(panel.getByRole("textbox", { name: "Commit message" })).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Generate Commit Message with AI" })).toBeVisible();
});

test("AI settings stage provider and key changes until Apply", async ({ workbench: page }) => {
  await stubRepository(page);
  await stubAi(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.vcs_commit_ai_save_settings = (args) => ({ config: args.config, hasApiKey: !!args.apiKey });
    const module = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ module);
    await executeAction("file.settings", "vcs.commit.ai");
  });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Base URL" })).toHaveValue("http://127.0.0.1:1234/v1");
  await dialog.getByRole("textbox", { name: "Base URL" }).fill("https://example.com/custom/v1");
  await dialog.getByRole("textbox", { name: "Model", exact: true }).fill("my-model");
  await dialog.getByLabel("API key", { exact: true }).fill("test-api-key");
  expect(await ipcCalls(page, "vcs_commit_ai_save_settings")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "vcs_commit_ai_save_settings")).length).toBe(1);
  const [saved] = await ipcCalls(page, "vcs_commit_ai_save_settings");
  expect(saved).toEqual({
    config: { baseUrl: "https://example.com/custom/v1", model: "my-model" },
    apiKey: "test-api-key",
  });
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Remove stored API key" })).toBeVisible();
  if (process.env.OPENIDEA_AI_EVIDENCE) {
    await dialog.screenshot({ path: `${process.env.OPENIDEA_AI_EVIDENCE}/settings.png`, animations: "disabled" });
  }
  await dialog.getByRole("button", { name: "Remove stored API key" }).click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "vcs_commit_ai_save_settings")).length).toBe(2);
  expect((await ipcCalls(page, "vcs_commit_ai_save_settings"))[1]!.apiKey).toBe("");
});
