import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const root = "/dev/acme-api";
const paths = ["alpha/one.txt", "beta/two.txt", "other/three.txt"].map((rel) => `${root}/${rel}`);

async function openUnversionedFiles(page: Page, groupByRepo: boolean) {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, paths, groupByRepo }) => {
      const vcsModule = "/src/features/vcs/store.ts";
      const commitModule = "/src/features/vcs/commitStore.ts";
      const { useVcs, refreshNow } = await import(vcsModule);
      const { useCommit } = await import(commitModule);
      useCommit.setState({ groupByDir: true, groupByRepo, showUnversionedSeparately: true });
      const roots = groupByRepo ? paths.map((path) => path.slice(0, path.lastIndexOf("/"))) : [root];
      const branch = { head: "main", headCommit: "1111111", operation: null };
      const h = window.__ipc.handlers;
      h.vcs_branch_info = () => ({ ...branch, upstream: null, ahead: 0, behind: 0 });
      h.vcs_roots = () => roots.map((root) => ({ ...branch, root }));
      h.vcs_status = () =>
        paths.map((path, index) => ({
          path,
          relPath: path.slice((groupByRepo ? roots[index]! : root).length + 1),
          staged: null,
          unstaged: "untracked",
          renamedFrom: null,
        }));
      h.vcs_stage = () => null;
      useVcs.setState({ available: true, root, repo: roots[0], branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, paths, groupByRepo },
  );
  await page.keyboard.press("Meta+k");
  return page.getByRole("tree", { name: "Changes", exact: true });
}

for (const grouping of ["repositories", "folders"] as const) {
  test(`Add to VCS includes both selected ${grouping}`, async ({ workbench: page }) => {
    const tree = await openUnversionedFiles(page, grouping === "repositories");
    await tree
      .getByRole("treeitem", { name: /Unversioned Files/ })
      .locator("[data-tree-toggle]")
      .click();
    const first = tree.getByText("alpha", { exact: true });
    await first.click();
    await tree.getByText("beta", { exact: true }).click({ modifiers: ["Meta"] });
    await expect(tree.locator('[aria-selected="true"]')).toHaveCount(2);
    await first.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Add to VCS/ }).click();
    const selected = paths.slice(0, 2);
    const expected = grouping === "repositories" ? selected.map((path) => ({ paths: [path] })) : [{ paths: selected }];
    await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual(expected);
  });
}

test("Add to VCS on the Unversioned Files header continues after a locked repository", async ({ workbench: page }) => {
  const tree = await openUnversionedFiles(page, true);
  await page.evaluate((locked) => {
    window.__ipc.handlers.vcs_stage = ({ paths }) => {
      if ((paths as string[]).includes(locked)) throw { kind: "io", message: "Git index is locked" };
    };
  }, paths[0]!);
  await tree.getByRole("treeitem", { name: /Unversioned Files/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Add to VCS/ }).click();
  await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual(paths.map((path) => ({ paths: [path] })));
  await expect(page.getByRole("alert").filter({ hasText: "Git index is locked" })).toContainText("alpha");
});
