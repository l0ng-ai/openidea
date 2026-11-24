import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("groups stashes by repository and keeps the selected stash actions scoped", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const main = "/dev/acme-api";
    const service = `${main}/warehouse-api`;
    const stash = (index: number, id: string, title: string) => ({
      index,
      id,
      message: `On main: ${title}`,
      base: "base",
      timeMs: new Date(2025, 4, 14, 10, 30).getTime(),
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_stashes = ({ repo }) =>
      repo === service
        ? [stash(0, "warehouse-stash", "Review warehouse routing")]
        : [stash(0, "ledger-stash", "Check totals"), stash(1, "invoice-stash", "Match invoice balances")];
    handlers.vcs_commit_files = ({ repo }) => [
      { path: repo === service ? "routing.txt" : "totals.txt", kind: "modified", oldPath: null },
    ];
    const store = "/src/features/vcs/store.ts";
    const context = "/src/platform/context.ts";
    const actions = "/src/platform/actions.ts";
    const toolWindows = "/src/workbench/toolwindows/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    const { setContext } = await import(/* @vite-ignore */ context);
    const { executeAction } = await import(/* @vite-ignore */ actions);
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ toolWindows);
    useVcs.setState({ available: true, root: main, repo: main, roots: [main, service] });
    setContext("vcsAvailable", true);
    moveToolWindow("commit", "bottom");
    await executeAction("vcs.showStashes");
    setToolWindowSize("bottom", 310);
  });

  const tree = page.getByRole("tree", { name: "Stashes", exact: true });
  const main = tree.getByRole("treeitem").filter({ has: page.getByText("acme-api", { exact: true }) });
  const service = tree.getByRole("treeitem", { name: /warehouse-api/ });
  const apply = page
    .getByRole("toolbar", { name: "Stashes", exact: true })
    .getByRole("button", { name: "Apply Stash" });
  const first = tree.getByRole("treeitem", { name: /Check totals/ });
  await expect(service, "repository group starts expanded").toHaveAttribute("aria-expanded", "true");
  await expect(main).toHaveAccessibleName(/acme-api\s*2/);
  await expect(first).toHaveAttribute("aria-level", "2");
  await expect(first).toHaveAttribute("aria-selected", "true");

  for (const width of [1100, 440]) {
    await page.setViewportSize({ width, height: 720 });
    const subject = first.getByText("Check totals", { exact: true });
    const date = subject.locator("xpath=following-sibling::*[1]");
    await expect(date).toHaveText(/2025/);
    await expect.poll(() => subject.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(date).toHaveCSS("font-size", await subject.evaluate((el) => getComputedStyle(el).fontSize));
    const titleBox = (await subject.boundingBox())!;
    const dateBox = (await date.boundingBox())!;
    expect(dateBox.x - titleBox.x - titleBox.width).toBeCloseTo(6, 0);
  }

  await tree.focus();
  await tree.press("Home");
  await tree.press("ArrowLeft");
  await expect(main).toHaveAttribute("aria-expanded", "false");
  await expect(first).toHaveCount(0);
  await expect(apply).toBeDisabled();
  await expect(page.getByText("Select a stash to view its changes.")).toBeVisible();
  await tree.press("ArrowRight");
  await expect(first).toBeVisible();
  await tree.getByText("Review warehouse routing", { exact: true }).click();
  await expect(apply).toBeEnabled();
  await expect(page.getByRole("tree", { name: "Changed files" }).getByText("routing.txt")).toBeVisible();
  expect((await ipcCalls(page, "vcs_commit_files")).at(-1)).toEqual({
    repo: "/dev/acme-api/warehouse-api",
    commit: "warehouse-stash",
  });
});
