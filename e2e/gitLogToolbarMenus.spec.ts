/**
 * Git Log toolbar buttons close their popup when clicked again, as in IDEA, instead of
 * keeping it open (Branch) or replaying its opening (the menus). Git is stubbed at the IPC layer.
 */
import { expect, stubDesktop, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const id = (i: number) => i.toString(16).padStart(40, "0");
    const commits = Array.from({ length: 20 }, (_, i) => ({
      id: id(i),
      shortId: id(i).slice(-8),
      parents: i + 1 < 20 ? [id(i + 1)] : [],
      refs: i === 0 ? ["HEAD", "main"] : [],
      author: "Author",
      email: "author@example.com",
      timeMs: 20 - i,
      summary: `Commit ${i}`,
      message: `Commit ${i}`,
    }));
    const h = window.__ipc.handlers;
    h.vcs_log = ({ query }) => {
      const { skip, limit, range } = query as { skip: number; limit: number; range?: string };
      return range ? [] : commits.slice(skip, limit ? skip + limit : undefined);
    };
    h.vcs_log_refs = () => ({});
    h.vcs_log_users = () => ["Author <author@example.com>"];
    h.vcs_branches = () => [];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: id(0),
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_config_get = () => null;
    h.vcs_commit_files = () => [];
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map(() => ({
        message: "",
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: true });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });
  await expect(page.getByRole("listbox", { name: "Commits" }).getByRole("option").first()).toBeVisible();
});

test("a second click on a Git Log toolbar button closes its popup", async ({ workbench: page }) => {
  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const branchPopup = page.getByRole("dialog", { name: "Filter by Branch" });
  // Opened on HEAD: "Branch: HEAD".
  const branch = toolbar.getByRole("button", { name: /^Branch/ });
  await branch.click();
  await expect(branchPopup).toBeVisible();
  await branch.click();
  await expect(branchPopup).toBeHidden();

  // The menus: User, Date, the filters that don't fit (Paths), then the toolbar's own dropdowns.
  for (const [name, item] of [
    ["User", "Author <author@example.com>"],
    ["Date", "Last 7 Days"],
    ["More Filters", "Paths"],
    ["Graph Options", "By Commit Date"],
    ["View Options", "Tag Names"],
  ] as const) {
    const button = toolbar.getByRole("button", { name, exact: true });
    const row = page.getByRole("menuitem", { name: item }).or(page.getByRole("menuitemcheckbox", { name: item }));
    await button.click();
    await expect(row).toBeVisible();
    await button.click();
    await expect(row).toBeHidden();
    // Still closed a moment later: the click did not open it again.
    await page.waitForTimeout(300);
    await expect(row).toBeHidden();
    // And a third click opens it again.
    await button.click();
    await expect(row).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row).toBeHidden();
  }
});
