import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("the Git Merge form shows the command and selected options", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const service = `${root}/service`;
    const branchInfo = (repo: unknown) => ({
      head: repo === service ? "release" : "main",
      headCommit: "a1234567",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_branch_info = ({ repo }) => branchInfo(repo);
    handlers.vcs_branches = ({ repo }) => [
      { name: branchInfo(repo).head, remote: false, current: true },
      { name: repo === service ? "feature/service" : "feature/api", remote: false, current: false },
    ];
    handlers.vcs_merge_with = () => null;
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({ root, roots: [root, service], repo: root, branch: branchInfo(root), available: true });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.merge");
  });

  const dialog = page.getByRole("dialog", { name: /Merge into/ });
  const command = dialog.getByText("git merge", { exact: true });
  const repo = dialog.getByRole("button", { name: "Repository", exact: true });
  const branch = dialog.getByRole("button", { name: "Branch to merge", exact: true });
  const merge = dialog.getByRole("button", { name: "Merge", exact: true });
  const modifyOptions = dialog.getByRole("button", { name: "Modify options" });
  await expect(command).toBeVisible();
  const repoBox = (await repo.boundingBox())!;
  const commandBox = (await command.boundingBox())!;
  const branchBox = (await branch.boundingBox())!;
  expect(repoBox.x + repoBox.width).toBeLessThan(commandBox.x);
  expect(commandBox.x + commandBox.width).toBeLessThan(branchBox.x);
  expect(Math.abs(repoBox.y - branchBox.y)).toBeLessThan(1);
  await expect(repo).toBeFocused();
  await expect(merge).toBeDisabled();

  await repo.click();
  await page.getByRole("option", { name: "service", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Merge into release");
  await branch.click();
  await page.getByRole("option", { name: "feature/service", exact: true }).click();
  await expect(merge).toBeEnabled();
  await modifyOptions.click();
  await page.getByRole("menuitemcheckbox", { name: "--no-ff", exact: true }).click();
  const flags = dialog.getByRole("group", { name: "Merge options" });
  await expect(flags).toHaveText("--no-ff");
  await modifyOptions.click();
  await expect(page.getByRole("menuitemcheckbox", { name: "--ff-only", exact: true })).toBeDisabled();
  await page.getByRole("menuitemcheckbox", { name: "-m (commit message)", exact: true }).click();
  await expect(flags).toHaveText("--no-ff-m");

  const message = dialog.getByRole("textbox", { name: "Commit message", exact: true });
  await expect(message).toHaveCSS("font-size", await branch.evaluate((el) => getComputedStyle(el).fontSize));
  await page.setViewportSize({ width: 410, height: 620 });
  const narrowRepo = (await repo.boundingBox())!;
  const narrowBranch = (await branch.boundingBox())!;
  expect(narrowRepo.y + narrowRepo.height).toBeLessThan(narrowBranch.y);
  expect(narrowBranch.x + narrowBranch.width).toBeLessThan(410);
  await message.fill("Merge service changes\n\nReviewed the service update.");
  await merge.click();

  await expect
    .poll(() => ipcCalls(page, "vcs_merge_with"))
    .toEqual([
      {
        repo: "/dev/acme-api/service",
        branches: ["feature/service"],
        options: {
          noFf: true,
          ffOnly: false,
          squash: false,
          noCommit: false,
          message: "Merge service changes\n\nReviewed the service update.",
        },
      },
    ]);
});
