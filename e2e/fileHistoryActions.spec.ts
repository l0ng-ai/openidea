import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/src/new-name.ts`;
const REVISION = "a".repeat(40);

test("File History opens its revision and compares only that file with the working copy", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path, revision }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: revision, operation: null }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: revision,
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      h.vcs_branches = () => [];
      h.vcs_status = () => [];
      h.vcs_log = ({ query }) =>
        (query as { path?: string }).path
          ? [
              {
                id: revision,
                shortId: revision.slice(0, 8),
                parents: ["b".repeat(40)],
                refs: [],
                author: "Author",
                email: "author@example.com",
                timeMs: 1,
                summary: "Rename historical file",
                message: "Rename historical file",
                historyPath: "src/old-name.ts",
              },
            ]
          : [];
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => ["Author <author@example.com>"];
      h.vcs_log_details_batch = () => [];
      h.vcs_commit_files = () => [];
      h.vcs_file_at = ({ path: filePath }) => `historical contents of ${String(filePath)}\n`;
      h.vcs_diff_entries = ({ entries }) => (entries as unknown[]).map(() => ({ mode: "100644", gitlink: null }));
      h.fs_probe = () => ({ size: 32, binary: false, tooLarge: false });

      const storeModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ storeModule);
      useVcs.setState({
        available: true,
        root,
        repo: root,
        roots: [root],
        branchesLoaded: true,
        statusLoaded: true,
      });
      const contextModule = "/src/platform/context.ts";
      const { setContext } = await import(/* @vite-ignore */ contextModule);
      setContext("vcsAvailable", true);
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("vcs.showHistory", { path });
    },
    { root: ROOT, path: FILE, revision: REVISION },
  );

  const commits = page.getByRole("listbox", { name: "Commits" });
  const row = commits.getByRole("option", { name: /Rename historical file/ });
  await expect(row).toBeVisible();

  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu.getByRole("menuitem", { name: "Show File at Revision" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Compare with Local" }).click();

  await expect
    .poll(async () => ipcCalls(page, "vcs_file_at"))
    .toContainEqual({ path: `${ROOT}/src/old-name.ts`, rev: REVISION });
  // The working copy side is the file itself (an editable document), not the historical path.
  await expect
    .poll(async () => ipcCalls(page, "vcs_diff_entries"))
    .toContainEqual({
      entries: [
        { path: `${ROOT}/src/old-name.ts`, rev: REVISION },
        { path: FILE, rev: "WT" },
      ],
    });
  await expect(page.getByText(`historical contents of ${ROOT}/src/old-name.ts`).first()).toBeVisible();

  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Context menu" })
    .getByRole("menuitem", { name: "Show File at Revision" })
    .click();
  await expect
    .poll(async () => ipcCalls(page, "vcs_file_at"))
    .toContainEqual({ path: `${ROOT}/src/old-name.ts`, rev: REVISION });
});
