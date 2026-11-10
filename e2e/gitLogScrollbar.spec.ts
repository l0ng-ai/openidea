import { expect, stubDesktop, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
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
});

test("keeps a wide Git graph filled during scrollbar drags and its edges interactive afterwards", async ({
  workbench: page,
}) => {
  const list = page.getByRole("listbox", { name: "Commits" });
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

for (const delta of [26, 780]) {
  test(`keeps hover feedback quiet under a stationary pointer while wheel-scrolling ${delta}px`, async ({
    workbench: page,
  }) => {
    const list = page.getByRole("listbox", { name: "Commits" });
    const row = list.getByRole("option").nth(3);
    const node = row.locator('svg[aria-label="Commit graph"] > g');
    await node.hover();
    const hoverBackground = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    const highlighted = list.locator('svg circle[r="6"], svg path[stroke-width="2.8"]');
    await expect(highlighted.first()).toBeAttached();
    const box = (await node.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const frames: { graph: number; row: boolean }[] = [];
    for (let i = 0; i < 18; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(25);
      frames.push(
        await list.evaluate(
          (element, { point, hoverBackground }) => {
            const hovered = document.elementFromPoint(point.x, point.y)?.closest('[role="option"]');
            return {
              graph: element.querySelectorAll('svg circle[r="6"], svg path[stroke-width="2.8"]').length,
              row: !!hovered && getComputedStyle(hovered).backgroundColor === hoverBackground,
            };
          },
          { point, hoverBackground },
        ),
      );
    }
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
    expect(
      frames.filter((frame) => frame.graph > 0),
      "graph highlights during scrolling",
    ).toEqual([]);
    expect(
      frames.filter((frame) => frame.row),
      "row hover backgrounds during scrolling",
    ).toEqual([]);

    await page.waitForTimeout(200);
    await expect(highlighted).toHaveCount(0);
    expect(
      await page.evaluate(
        ({ point, hoverBackground }) => {
          const row = document.elementFromPoint(point.x, point.y)?.closest('[role="option"]');
          return row && getComputedStyle(row).backgroundColor === hoverBackground;
        },
        { point, hoverBackground },
      ),
      "a stationary pointer does not reactivate hover after the scroll idle delay",
    ).toBe(false);

    // A click still selects a commit before the scroll idle delay has elapsed.
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(25);
    const listBox = (await list.boundingBox())!;
    await page.mouse.click(listBox.x + listBox.width - 100, point.y);
    await expect(list.getByRole("option", { selected: true })).toHaveCount(1);

    await page.waitForTimeout(200);
    const visibleIndex = await list.evaluate((element) => Math.ceil(element.scrollTop / 26) + 2);
    const visibleRow = list.locator(`[id="commit-log-${visibleIndex}"]`);
    await visibleRow.locator('svg[aria-label="Commit graph"] > g').hover();
    await expect(highlighted.first()).toBeAttached();
    await expect(visibleRow).toHaveCSS("background-color", hoverBackground);
  });
}

test("keeps recycled commit tooltips closed until the pointer moves after fast scrolling", async ({
  workbench: page,
}) => {
  const list = page.getByRole("listbox", { name: "Commits" });
  await list.getByText("Commit 3", { exact: true }).hover();
  for (let i = 0; i < 18; i++) {
    await page.mouse.wheel(0, 780);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(1000);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const index = await list.evaluate((element) => Math.ceil(element.scrollTop / 26) + 2);
  await list.getByText(`Commit ${index}`, { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText(`Commit ${index}`);
});
