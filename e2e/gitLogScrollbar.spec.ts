import { expect, stubDesktop, test } from "./fixtures";

test("keeps a wide Git graph filled during scrollbar drags and its edges interactive afterwards", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const count = 3000;
    const id = (i: number) => i.toString(16).padStart(40, "0");
    const commits = Array.from({ length: count }, (_, i) => ({
      id: id(i),
      shortId: id(i).slice(-8),
      parents: i + 18 < count ? [id(i + 18)] : [],
      refs: i === 0 ? ["HEAD", "main"] : [],
      author: "Author",
      email: "author@example.com",
      timeMs: count - i,
      summary: `Commit ${i}`,
      message: `Commit ${i}`,
    }));
    const h = window.__ipc.handlers;
    h.vcs_log = ({ query }) => {
      const { skip, limit, range } = query as {
        skip: number;
        limit: number;
        range?: string;
      };
      return range ? [] : commits.slice(skip, limit ? skip + limit : undefined);
    };
    h.vcs_log_refs = () => ({});
    h.vcs_branches = () => [];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: id(0),
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_config_get = () => null;
    h.vcs_commit_files = () => [];
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map((revision) => ({
        message: `Commit ${parseInt(revision, 16)}`,
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({
      available: true,
      root,
      repo: root,
      roots: [root],
      branchesLoaded: true,
    });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });
  const list = page.getByRole("listbox", { name: "Commits" });
  await expect(list.getByRole("option").first()).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/features/vcs/logStore.ts";
    const { useGitLog, loadMore } = await import(/* @vite-ignore */ module);
    while (!useGitLog.getState().done) await loadMore();
  });

  const box = (await list.boundingBox())!;
  const x = box.x + box.width - 5;
  await page.mouse.move(x, box.y + 8);
  await page.mouse.down();
  try {
    for (const fraction of [0.2, 0.7, 0.4, 0.85, 0.3]) {
      await page.mouse.move(x, box.y + box.height * fraction, { steps: 8 });
      expect(
        await list.evaluate((element) => {
          const top = element.scrollTop;
          const positions = [...element.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.offsetTop);
          return {
            scrolling: top > 0,
            covered: Math.min(...positions) <= top && Math.max(...positions) + 26 >= top + element.clientHeight,
          };
        }),
      ).toEqual({ scrolling: true, covered: true });
    }
  } finally {
    await page.mouse.up();
  }

  const index = await list.evaluate((element) => Math.ceil(element.scrollTop / 26));
  const row = list.locator(`[id="commit-log-${index}"]`);
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await list.press("ArrowDown");
  await expect(list.locator(`[id="commit-log-${index + 1}"]`)).toHaveAttribute("aria-selected", "true");
  // Rows drawn mid-drag get their edge hit targets back once scrolling stops.
  await expect(row.getByRole("button", { name: "Collapse this fragment" }).first()).toBeAttached();
});
