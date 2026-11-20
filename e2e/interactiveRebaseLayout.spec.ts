import { expect, stubDesktop, test } from "./fixtures";

test("Interactive rebase keeps commit messages and plan controls usable at narrow widths", async ({
  workbench: page,
}) => {
  const first = "Keep regional settlement references stable when reconciling delayed ledger updates";
  const second = "Add settlement summary";
  await stubDesktop(page);
  await page.evaluate(
    async ({ first, second }) => {
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
      h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: id("c") }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: id("c"),
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      h.vcs_status = () => [];
      h.vcs_log = () => commits;
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => ["Sam Rivera <sam@example.com>"];
      h.vcs_config_get = () => null;
      h.vcs_commit_files = () => [];
      h.vcs_log_details_batch = () => [];
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root, roots: [root], repo: root, branchesLoaded: true });
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { first, second },
  );
  const log = page.getByRole("listbox", { name: "Commits" });
  await log.getByRole("option", { name: new RegExp(first) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Interactively Rebase from Here/ }).click();
  const dialog = page.getByRole("dialog", { name: /Rebasing 2 commits/ });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 440, height: 640 });
  const list = dialog.getByRole("list", { name: "Commits to rebase" });
  const originalRows = list.getByRole("listitem");
  await dialog.getByRole("button", { name: "Action for bbbbbbbb" }).click();
  await page.getByRole("option", { name: "Reword", exact: true }).click();
  const reword = dialog.getByRole("textbox", { name: "New message for bbbbbbbb" });
  await expect(reword).toHaveValue(first + "\n\nKeep the audit trail linked to the settlement job.");
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

  await page.setViewportSize({ width: 1120, height: 760 });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(details).toContainText(second);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
