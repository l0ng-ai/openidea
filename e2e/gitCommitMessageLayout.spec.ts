import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("the history message editor shows commit context and grows with the dialog", async ({ workbench: page }) => {
  const author = "Sam Rivera";
  const earlier = "Keep the settlement audit trail";
  const latest = "Finalize the settlement report";
  const detail = "Preserve the original export for review.";
  await page.setViewportSize({ width: 1120, height: 760 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ author, earlier, latest, detail }) => {
      const root = "/dev/acme-api";
      const head = "c".repeat(40);
      const branch = { head: "main", headCommit: head, upstream: null, ahead: 0, behind: 0, operation: null };
      const commits = [
        { id: head, shortId: "cccccccc", parents: ["b".repeat(40)], summary: latest },
        { id: "b".repeat(40), shortId: "bbbbbbbb", parents: ["a".repeat(40)], summary: earlier },
      ].map((commit) => ({
        ...commit,
        author,
        email: "sam@example.invalid",
        refs: [],
        timeMs: 1795100200000,
        message: commit.summary + "\n\n" + detail,
      }));
      const handlers = window.__ipc.handlers;
      handlers.vcs_roots = () => [{ root, ...branch }];
      handlers.vcs_branch_info = () => branch;
      handlers.vcs_status = () => [];
      handlers.vcs_log = ({ query }) =>
        (query as { range: string | null }).range?.startsWith("b".repeat(40)) ? commits.slice(0, 1) : commits;
      handlers.vcs_log_refs = () => ({});
      handlers.vcs_log_users = () => [author];
      handlers.vcs_config_get = () => null;
      handlers.vcs_commit_files = () => [];
      handlers.vcs_log_details_batch = () => [];
      handlers.vcs_reword = () => ({ before: head, after: "d".repeat(40) });

      const projectPath = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, fontSize: 16 } } });
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: true });
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { author, earlier, latest, detail },
  );

  const log = page.getByRole("listbox", { name: "Commits" });
  const newest = log.getByRole("option", { name: new RegExp(latest) });
  const older = log.getByRole("option", { name: new RegExp(earlier) });
  await newest.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Edit Commit Message/ }).click();
  const edit = page.getByRole("dialog", { name: /^Edit Commit Message/ });
  const context = "Edit message for commit cccccccc by " + author;
  await expect(edit.getByText(context, { exact: true })).toBeVisible();
  const message = edit.getByRole("textbox", { name: context });
  await expect(message).toBeFocused();
  await expect(message).toHaveValue(latest + "\n\n" + detail);
  await expect(message).toHaveCSS("font-size", "16px");

  const grip = edit.getByRole("separator", { name: "Resize" });
  const before = (await message.boundingBox())!;
  const corner = (await grip.boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 72, corner.y + corner.height / 2 + 40);
  await page.mouse.up();
  await expect.poll(async () => (await message.boundingBox())!.width).toBeGreaterThan(before.width + 60);
  await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThan(before.height + 30);

  const ok = edit.getByRole("button", { name: "OK", exact: true });
  await message.fill(" ");
  await expect(ok).toBeDisabled();
  const revised = "Finalize the reviewed settlement report\n\n" + detail;
  await message.fill(revised);
  await ok.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_reword"))
    .toEqual([{ repo: "/dev/acme-api", commit: "c".repeat(40), message: revised }]);

  await newest.click();
  await older.click({ modifiers: ["Shift"] });
  await newest.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Squash Commits/ }).click();
  const squash = page.getByRole("dialog", { name: "Squashed Commit Message" });
  const combined = squash.getByRole("textbox", { name: "Edit message for squashed commit" });
  await expect(combined).toHaveValue([earlier, detail, latest, detail].join("\n\n"));
  await page.setViewportSize({ width: 420, height: 490 });
  await expect(combined).toBeInViewport({ ratio: 1 });
  await expect(squash.getByRole("button", { name: "OK", exact: true })).toBeInViewport({ ratio: 1 });
  await squash.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(squash).toBeHidden();
});
