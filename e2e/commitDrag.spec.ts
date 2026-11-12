/**
 * Dragging an unversioned file onto a changelist in the Commit tool window: it is
 * added to Git (IDEA's Unversioned Files behaviour) and joins that list.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

/** A repository with a modified tracked file and an untracked one; staging tracks the latter. */
async function stubRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    let staged = false;
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
    h.vcs_status = () => [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      {
        path: `${root}/notes.txt`,
        relPath: "notes.txt",
        staged: staged ? "added" : null,
        unstaged: staged ? null : "untracked",
        renamedFrom: null,
      },
    ];
    h.vcs_stage = () => {
      staged = true;
      return null;
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

test("dragging an unversioned file onto a changelist adds it to Git", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });

  // Unversioned Files starts collapsed.
  await changes
    .getByRole("treeitem", { name: /Unversioned Files/ })
    .locator("[data-tree-toggle]")
    .click();
  const source = changes.getByText("notes.txt", { exact: true });
  await expect(source).toBeVisible();
  const target = changes.getByText("Changes", { exact: true }).first();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();

  // The drop adds the file to Git instead of only moving a changelist assignment.
  await expect.poll(async () => (await ipcCalls(page, "vcs_stage")).length).toBe(1);
  expect((await ipcCalls(page, "vcs_stage"))[0]).toMatchObject({ paths: [`${ROOT}/notes.txt`] });

  // It is versioned now: the Unversioned Files group is gone and the file stays under Changes.
  await expect(changes.getByRole("treeitem", { name: /Unversioned Files/ })).toHaveCount(0);
  await expect(changes.getByRole("treeitem", { name: /notes\.txt/ })).toBeVisible();
});
