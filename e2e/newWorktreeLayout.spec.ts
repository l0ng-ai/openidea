import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("New Worktree keeps form fields aligned and creates the selected worktree in a short window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const service = `${root}/service`;
    window.__ipc.handlers.vcs_branches = () => [{ name: "main", current: true, remote: false }];
    window.__ipc.handlers.vcs_tags = () => [];
    window.__ipc.handlers.vcs_worktrees = ({ repo }) => [{ path: repo, branch: "main", main: true, submodule: false }];
    window.__ipc.handlers.vcs_worktree_include = () => ({ exists: true });
    window.__ipc.handlers.vcs_add_worktree = () => ({ copyWarning: null, setupWarning: null });
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({ root, roots: [root, service], repo: root, available: true });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.newWorktree");
  });

  const dialog = page.getByRole("dialog", { name: "New Worktree" });
  const name = dialog.getByRole("textbox", { name: "Name:" });
  const branch = dialog.getByRole("textbox", { name: "New branch name" });
  const location = dialog.getByRole("textbox", { name: "Location:" });
  const repository = dialog.getByRole("button", { name: "Repository", exact: true });
  const checkout = dialog.getByRole("button", { name: "Check out", exact: true });
  const setup = dialog.getByRole("checkbox", { name: "Run setup script" });
  const script = dialog.getByRole("textbox", { name: "Setup script:" });
  await expect(name).toHaveValue("acme-api-main-wt");
  await branch.fill("review/ledger-batch");
  await name.fill("ledger-review");
  await location.fill("/dev/reviews");
  await setup.check();
  await script.fill("/dev/setup.sh");
  const preview = dialog.getByText("Worktree location: /dev/reviews/ledger-review", { exact: true });
  await expect(preview).toBeVisible();

  for (const size of [
    { width: 1120, height: 740 },
    { width: 440, height: 520 },
  ]) {
    await page.setViewportSize(size);
    const column = (await name.boundingBox())!.x;
    for (const [label, field] of [
      ["Name:", name],
      ["Location:", location],
      ["Repository:", repository],
      ["Check out:", checkout],
      ["Create a new branch", branch],
      ["Setup script:", script],
    ] as const) {
      const caption = dialog.getByText(label, { exact: true });
      await expect(caption).toBeVisible();
      const captionBox = (await caption.boundingBox())!;
      const fieldBox = (await field.boundingBox())!;
      expect(fieldBox.x, label).toBeCloseTo(column, 0);
      expect(captionBox.x + captionBox.width, label).toBeLessThanOrEqual(fieldBox.x);
      expect(captionBox.y + captionBox.height / 2, label).toBeCloseTo(fieldBox.y + fieldBox.height / 2, 0);
    }
    expect((await preview.boundingBox())!.x).toBeCloseTo(column, 0);
  }

  await setup.uncheck();
  await expect(script).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await ipcCalls(page, "vcs_add_worktree")).toEqual([
    {
      repo: "/dev/acme-api",
      path: "/dev/reviews/ledger-review",
      commitish: "refs/heads/main",
      newBranch: "review/ledger-batch",
      copyConfig: true,
      setup: null,
    },
  ]);
});
