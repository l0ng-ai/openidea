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
  // The commit takes the checked file itself; the index isn't staged beforehand.
  expect((committed!.options as { stage: string[] }).stage).toEqual([`${ROOT}/build.gradle.kts`]);
  expect(await ipcCalls(page, "vcs_stage")).toHaveLength(0);
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});
