import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Rebase shows its command and the two bases for --onto", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const service = `${root}/service`;
    const branchInfo = (repo: unknown) => ({
      head: repo === service ? "feature/service" : "feature/api",
      headCommit: "a1234567",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_branch_info = ({ repo }) => branchInfo(repo);
    const serviceBranches = new Promise<void>((resolve) => {
      handlers.test_release_service_branches = () => resolve();
    });
    handlers.vcs_branches = async ({ repo }) => {
      if (repo === service) await serviceBranches;
      return [
        { name: branchInfo(repo).head, remote: false, current: true },
        ...(repo === service ? ["release", "integration"] : ["main", "review"]).map((name) => ({
          name,
          remote: false,
          current: false,
        })),
      ];
    };
    handlers.vcs_rebase_with = () => null;
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({ root, roots: [root, service], repo: root, branch: branchInfo(root), available: true });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.rebase");
  });

  const dialog = page.getByRole("dialog", { name: /^Rebase/ });
  const command = dialog.getByText("git rebase", { exact: true });
  const repo = dialog.getByRole("button", { name: "Repository", exact: true });
  const upstream = dialog.getByRole("button", { name: "Upstream", exact: true });
  const submit = dialog.getByRole("button", { name: "Rebase", exact: true });
  const options = dialog.getByRole("button", { name: "Modify options", exact: true });
  const pick = async (trigger: typeof repo, value: string) => {
    await trigger.click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  const flag = async (label: string) => {
    await options.click();
    await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
  };

  await expect(command).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Rebase feature/api");
  const { repoBox, commandBox, upstreamBox } = await dialog.evaluate((el) => {
    const box = (selector: string) => {
      const { x, y, width } = el.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width };
    };
    return {
      repoBox: box('button[aria-label="Repository"]'),
      commandBox: box("code"),
      upstreamBox: box('button[aria-label="Upstream"]'),
    };
  });
  expect(repoBox.x + repoBox.width).toBeLessThan(commandBox.x);
  expect(commandBox.x + commandBox.width).toBeLessThan(upstreamBox.x);
  expect(Math.abs(repoBox.y - upstreamBox.y)).toBeLessThan(1);
  await expect(submit).toBeDisabled();

  await pick(upstream, "main");
  await expect(submit).toBeEnabled();
  await pick(repo, "service");
  await expect(dialog).toHaveAccessibleName("Rebase feature/service");
  await expect(upstream).toHaveText("Select branch");
  await expect(submit).toBeDisabled();
  await upstream.click();
  await expect(page.getByRole("option", { name: "main", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__ipc.handlers.test_release_service_branches?.({}));
  await page.getByRole("option", { name: "release", exact: true }).click();
  await flag("--onto");
  const oldBase = dialog.getByRole("button", { name: "Old base", exact: true });
  const newBase = dialog.getByRole("button", { name: "New base", exact: true });
  await expect(oldBase).toHaveText("release");
  await expect(submit).toBeDisabled();
  const oldBox = (await oldBase.boundingBox())!;
  const newBox = (await newBase.boundingBox())!;
  expect(oldBox.y).toBeGreaterThan(newBox.y);
  await pick(newBase, "integration");
  await flag("--rebase-merges");
  await flag("--keep-empty");
  await expect(dialog.getByRole("group", { name: "Rebase options" })).toHaveText("--rebase-merges--keep-empty");

  await page.setViewportSize({ width: 410, height: 620 });
  const narrowRepo = (await repo.boundingBox())!;
  const narrowCommand = (await command.boundingBox())!;
  const narrowNewBase = (await newBase.boundingBox())!;
  expect(narrowRepo.y + narrowRepo.height).toBeLessThan(narrowCommand.y);
  expect(narrowNewBase.x + narrowNewBase.width).toBeLessThan(410);
  await submit.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_rebase_with"))
    .toEqual([
      {
        repo: "/dev/acme-api/service",
        upstream: "release",
        options: { onto: "integration", rebaseMerges: true, keepEmpty: true },
      },
    ]);
});
