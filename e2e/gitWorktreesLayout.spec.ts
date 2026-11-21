import { expect, stubDesktop, test } from "./fixtures";

test("Worktrees places actions beside the tree and shows the folder above its branch", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const service = `${root}/service`;
    const worktree = (path: string, branch: string | null, main = false, locked = false) => ({
      path,
      branch,
      head: "a1234567e312",
      main,
      locked,
      prunable: false,
    });
    window.__ipc.handlers.vcs_worktrees = ({ repo }) =>
      repo === service
        ? [worktree(service, "release", true), worktree("/dev/service-snapshot", null)]
        : [worktree(root, "main", true), worktree("/dev/review-worktree", "feature/review", false, true)];
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({ root, roots: [root, service], repo: root, available: true });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.worktrees");
  });

  const dialog = page.getByRole("dialog", { name: "Worktrees", exact: true });
  const toolbar = dialog.getByRole("toolbar", { name: "Worktrees", exact: true });
  const tree = dialog.getByRole("tree", { name: "Worktrees", exact: true });
  await expect(tree.getByText("feature/review", { exact: true })).toBeVisible();
  const barBox = (await toolbar.boundingBox())!;
  const treeBox = (await tree.boundingBox())!;
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(treeBox.x);
  const row = tree.getByRole("treeitem", { name: /review-worktree.*feature\/review/ });
  const name = row.getByText("review-worktree", { exact: true });
  const branch = row.getByText("feature/review", { exact: true });
  const nameBox = (await name.boundingBox())!;
  const branchBox = (await branch.boundingBox())!;
  expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(branchBox.y);
  await expect(name).toHaveCSS("font-size", await branch.evaluate((el) => getComputedStyle(el).fontSize));
  await expect(row.getByRole("img", { name: "locked", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /service-snapshot.*a1234567/ })).toBeVisible();

  await tree.focus();
  await tree.press("End");
  await tree.press("r");
  await tree.press("e");
  await tree.press("v");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await tree.press("Escape");
  await expect(row.getByText("/dev/review-worktree", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("toolbar", { name: "Tool windows" }).getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("tab", { name: "Worktrees", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Worktrees", exact: true });
  const dockedTree = panel.getByRole("tree", { name: "Worktrees", exact: true });
  await expect(dockedTree.getByRole("treeitem", { name: /review-worktree.*feature\/review/ })).toBeVisible();
  const dockedBarBox = (await panel.getByRole("toolbar", { name: "Worktrees" }).boundingBox())!;
  const dockedTreeBox = (await dockedTree.boundingBox())!;
  expect(dockedBarBox.x + dockedBarBox.width).toBeLessThanOrEqual(dockedTreeBox.x);
});
