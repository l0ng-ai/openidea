import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Stash wraps the current branch and accepts a multiline message in a narrow window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 380, height: 590 });
  await stubDesktop(page);
  const root = "/dev/settlement-engine";
  const head = "release/QuarterlyInternationalSettlementReconciliationAndAuthorizationForMerchantOperations";
  await page.evaluate(
    async ({ root, head }) => {
      const branch = { head, headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null };
      const h = window.__ipc.handlers;
      h.vcs_branch_info = () => branch;
      h.vcs_roots = () => [{ root, ...branch }];
      h.vcs_status = () => [];
      h.vcs_stashes = () => [];
      h.vcs_stash_push = () => null;
      const storeModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ storeModule);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branch });
      const contextModule = "/src/platform/context.ts";
      const { setContext } = await import(/* @vite-ignore */ contextModule);
      setContext("vcsAvailable", true);
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("vcs.stash");
    },
    { root, head },
  );

  const dialog = page.getByRole("dialog", { name: "Stash", exact: true });
  await expect(dialog.getByText(`Current branch: ${head}`)).toBeVisible();
  const body = dialog.locator("[data-dialog-body]");
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  const message = dialog.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeFocused();
  await message.fill("Set aside settlement work");
  await message.press("End");
  await message.press("Enter");
  await expect(message).toHaveValue("Set aside settlement work\n");
  await message.pressSequentially("Continue after the release.");
  expect(await ipcCalls(page, "vcs_stash_push")).toEqual([]);

  await dialog.getByRole("checkbox", { name: "Keep index" }).check();
  await dialog.getByRole("checkbox", { name: "Include untracked files" }).check();
  await message.press("Control+Enter");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "vcs_stash_push"))
    .toEqual([
      {
        repo: root,
        message: "Set aside settlement work\nContinue after the release.",
        keepIndex: true,
        includeUntracked: true,
        paths: null,
      },
    ]);
});
