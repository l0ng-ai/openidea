/**
 * Show Diff over the editor through the VCS Operations popup: it targets the editor's file, not
 * the file the Project view still has selected. Git is stubbed at the IPC layer.
 */
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const TABLIST = "Editor tabs";

test("Show Diff from the VCS Operations popup opens the editor's file, not the Project view selection", async ({
  workbench: page,
}) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const changes = ["build.gradle.kts", "README.md"].map((relPath) => ({
      path: `${root}/${relPath}`,
      relPath,
      staged: null,
      unstaged: "modified",
      renamedFrom: null,
    }));
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
    h.vcs_status = () => changes;
    h.vcs_file_at = () => "";
    h.vcs_compare_scope = () => ({ repositories: [root], skippedPaths: [], singleFile: true });
    const store = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);

  // The Project view keeps README.md selected while the editor goes back to build.gradle.kts.
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page
    .getByRole("tablist", { name: TABLIST })
    .getByRole("tab", { name: "build.gradle.kts", exact: true })
    .click();
  await editor.locator(".cm-content").click();

  await page.keyboard.press("Control+v");
  await page.getByRole("menuitem", { name: /Show Diff/ }).click();

  await expect(page.getByRole("tab", { name: "build.gradle.kts (HEAD ↔ Your version)" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "README.md (HEAD ↔ Your version)" })).toHaveCount(0);
});
