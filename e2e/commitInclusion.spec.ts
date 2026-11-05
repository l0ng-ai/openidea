/**
 * #1539: committing a subset of the changed files must not check the ones left out again.
 * Git is stubbed at the IPC layer, like `commit.spec.ts`.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const NAMES = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);

/** Twenty modified tracked files; `vcs_stage` + `vcs_commit` take the staged ones out of the status. */
async function stubTwentyChanges(page: Page) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, names }) => {
      const staged = new Set<string>();
      const committed = new Set<string>();
      const all = names.map((rel) => ({
        path: `${root}/${rel}`,
        relPath: rel,
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      }));
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
      h.vcs_status = () => all.filter((f) => !committed.has(f.path));
      h.vcs_stage = (args) => {
        for (const path of args.paths as string[]) staged.add(path);
        return null;
      };
      h.vcs_unstage = () => null;
      h.vcs_commit = () => {
        for (const path of staged) committed.add(path);
        staged.clear();
        return "2222222";
      };
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root: ROOT, names: NAMES },
  );
}

test("changes left out of a commit stay unchecked (#1539)", async ({ workbench: page }, testInfo) => {
  await stubTwentyChanges(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });

  // Uncheck everything, then pick the 5 files to commit.
  await changes.getByRole("checkbox", { name: "Include Changes in commit" }).click();
  for (const name of NAMES.slice(0, 5)) {
    await changes.getByRole("checkbox", { name: `Include ${name.split("/").pop()} in commit` }).click();
  }
  await expect(changes.getByRole("checkbox", { name: "Include f0.ts in commit" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await panel.getByRole("textbox", { name: "Commit message" }).fill("Commit 5 of 20");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByText(/5 files committed: Commit 5 of 20/)).toBeVisible();
  expect((await ipcCalls(page, "vcs_stage")).flatMap((a) => a.paths as string[]).sort()).toEqual(
    NAMES.slice(0, 5)
      .map((rel) => `${ROOT}/${rel}`)
      .sort(),
  );

  // The 15 files left out are still in the tree, unchecked: the next commit cannot take them by surprise.
  const leftOut = changes.getByRole("checkbox", { name: "Include f19.ts in commit" });
  await expect(leftOut).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("commit-inclusion.png"), animations: "disabled" });
  for (const name of NAMES.slice(5)) {
    await expect(changes.getByRole("checkbox", { name: `Include ${name.split("/").pop()} in commit` })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  }
});
