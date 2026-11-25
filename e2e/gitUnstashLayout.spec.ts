import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Unstash aligns its controls and restores the selected repository's stash", async ({ workbench: page }) => {
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
    handlers.vcs_stashes = ({ repo }) =>
      (repo === service ? ["Service cleanup", "Review cache changes"] : ["Update API totals"]).map(
        (message, index) => ({
          index,
          message,
          timeMs: null,
          id: `stash-${index}`,
          base: "a1234567",
        }),
      );
    handlers.vcs_stash_apply = () => ({ index: 1, outcome: { kind: "done" } });
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({ root, roots: [root, service], repo: root, branch: branchInfo(root), available: true });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.unstash");
  });

  const dialog = page.getByRole("dialog", { name: "Unstash Changes", exact: true });
  const label = dialog.getByText("As new branch:", { exact: true });
  const branch = dialog.getByRole("textbox", { name: /^As new branch/ });
  const changes = dialog.getByRole("button", { name: "Show Changes", exact: true });
  const drop = dialog.getByRole("button", { name: "Drop Stash", exact: true });
  const pop = dialog.getByRole("checkbox", { name: "Pop stash", exact: true });
  const index = dialog.getByRole("checkbox", { name: "Reinstate index", exact: true });
  const labelBox = (await label.boundingBox())!;
  const branchBox = (await branch.boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThan(branchBox.x);
  await expect(label).toHaveCSS("font-size", await branch.evaluate((el) => getComputedStyle(el).fontSize));
  const stashes = dialog.getByRole("radiogroup", { name: "Stashes:" });
  const listBox = (await stashes.boundingBox())!;
  const changesBox = (await changes.boundingBox())!;
  const dropBox = (await drop.boundingBox())!;
  expect(listBox.x + listBox.width).toBeLessThan(changesBox.x);
  expect(Math.abs(changesBox.x - dropBox.x)).toBeLessThan(1);
  expect(Math.abs((await pop.boundingBox())!.y - (await index.boundingBox())!.y)).toBeLessThan(1);
  await expect(dialog.getByText("main", { exact: true })).toBeVisible();
  await expect(stashes.getByRole("radio", { name: /Update API totals/ })).toBeChecked();

  await branch.fill("api-copy");
  await dialog.getByRole("button", { name: "Repository", exact: true }).click();
  await page.getByRole("option", { name: "service", exact: true }).click();
  await expect(dialog.getByText("release", { exact: true })).toBeVisible();
  await expect(branch).toHaveValue("");
  await expect(stashes.getByRole("radio", { name: /Update API totals/ })).toHaveCount(0);
  const newest = stashes.getByRole("radio", { name: /Service cleanup/ });
  await expect(newest).toBeChecked();
  await newest.focus();
  await newest.press("ArrowDown");
  await expect(stashes.getByRole("radio", { name: /Review cache changes/ })).toBeChecked();

  await page.setViewportSize({ width: 400, height: 620 });
  const narrowLabel = (await label.boundingBox())!;
  const narrowBranch = (await branch.boundingBox())!;
  expect(narrowLabel.y + narrowLabel.height).toBeLessThan(narrowBranch.y);
  expect(Math.abs(narrowLabel.x - narrowBranch.x)).toBeLessThan(1);
  await branch.fill("review/cache");
  await expect(pop).toBeChecked();
  await expect(index).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Create Branch", exact: true })).toBeEnabled();
  await branch.clear();
  await pop.check();
  await index.check();
  await dialog.getByRole("button", { name: "Pop Stash", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_stash_apply"))
    .toEqual([
      {
        repo: "/dev/acme-api/service",
        stash: { index: 1, message: "Review cache changes", timeMs: null, id: "stash-1", base: "a1234567" },
        pop: true,
        reinstateIndex: true,
        branch: null,
      },
    ]);
});
