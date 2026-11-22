/**
 * Git Log toolbar buttons close their popup when clicked again, as in IDEA, instead of
 * keeping it open (Branch) or replaying its opening (the menus). Git is stubbed at the IPC layer.
 */
import { expect, stubDesktop, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const id = (i: number) => i.toString(16).padStart(40, "0");
    const commits = Array.from({ length: 20 }, (_, i) => ({
      id: id(i),
      shortId: id(i).slice(-8),
      parents: i + 1 < 20 ? [id(i + 1)] : [],
      refs: i === 0 ? ["HEAD", "main"] : [],
      author: "Author",
      email: "author@example.com",
      timeMs: 20 - i,
      summary: `Commit ${i}`,
      message: `Commit ${i}`,
    }));
    const h = window.__ipc.handlers;
    h.vcs_log = ({ query }) => {
      const { skip, limit, range } = query as { skip: number; limit: number; range?: string };
      return range ? [] : commits.slice(skip, limit ? skip + limit : undefined);
    };
    h.vcs_log_refs = () => ({});
    h.vcs_log_users = () => ["Author <author@example.com>"];
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
      (revisions as string[]).map(() => ({
        message: "",
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: true });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });
  await expect(page.getByRole("listbox", { name: "Commits" }).getByRole("option").first()).toBeVisible();
});

test("Git Log separates commit message typography from compact metadata", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 860, height: 720 });
  await page.evaluate(() => {
    window.__ipc.handlers.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map(() => ({
        message: "Commit 1\n\nUpdate checkout totals after applying shipping discounts.",
        containingBranches: ["feature/update-checkout-totals-and-apply-shipping-discounts".repeat(3)],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
  });
  const setEditorSize = (fontSize: number) =>
    page.evaluate(async (fontSize) => {
      const module = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ module);
      const { settings } = useProject.getState();
      useProject.setState({
        settings: { ...settings, editor: { ...settings?.editor, fontFamily: "Consolas", fontSize } },
      });
    }, fontSize);
  await setEditorSize(18);
  const commits = page.getByRole("listbox", { name: "Commits" });
  await commits.getByRole("option").filter({ hasText: "Commit 1" }).first().click();

  const message = page.locator("#message");
  const subject = message.getByText("Commit 1", { exact: true });
  const body = message.getByText("Update checkout totals after applying shipping discounts.", { exact: true });
  await expect(body).toHaveCSS("font-size", "18px");
  await expect(body).toHaveCSS("font-family", /Consolas/);
  await expect(subject).toHaveCSS("font-size", "18px");
  const author = message.getByTitle("Copy revision number").locator("..");
  const parent = message.getByText(/^Parent\s/);
  await expect(author).toHaveCSS("font-size", "12px");
  const authorBox = (await author.boundingBox())!;
  const parentBox = (await parent.boundingBox())!;
  expect(parentBox.y - authorBox.y - authorBox.height).toBeLessThanOrEqual(4);
  const signature = message.getByText(/Signature: Unsigned/);
  await signature.scrollIntoViewIfNeeded();
  await expect(signature).toBeInViewport();
  const overflow = await message.evaluate((el) => {
    const scroller = el.querySelector('[class*="_messageBox_"]')!;
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  await setEditorSize(15);
  await expect(body).toHaveCSS("font-size", "15px");
  await expect(author).toHaveCSS("font-size", "12px");
});

test("a second click on a Git Log toolbar button closes its popup", async ({ workbench: page }) => {
  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const branchPopup = page.getByRole("dialog", { name: "Filter by Branch" });
  // Opened on HEAD: "Branch: HEAD".
  const branch = toolbar.getByRole("button", { name: /^Branch/ });
  await branch.click();
  await expect(branchPopup).toBeVisible();
  await branch.click();
  await expect(branchPopup).toBeHidden();

  // The menus: User, Date, the filters that don't fit (Paths), then the toolbar's own dropdowns.
  for (const [name, item] of [
    ["User", "Author <author@example.com>"],
    ["Date", "Last 7 Days"],
    ["More Filters", "Paths"],
    ["Graph Options", "By Commit Date"],
    ["View Options", "Tag Names"],
  ] as const) {
    const button = toolbar.getByRole("button", { name, exact: true });
    const row = page.getByRole("menuitem", { name: item }).or(page.getByRole("menuitemcheckbox", { name: item }));
    await button.click();
    await expect(row).toBeVisible();
    await button.click();
    await expect(row).toBeHidden();
    // Still closed a moment later: the click did not open it again.
    await page.waitForTimeout(300);
    await expect(row).toBeHidden();
    // And a third click opens it again.
    await button.click();
    await expect(row).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row).toBeHidden();
  }
});

test("Git Log keeps filters and actions inside the commit pane at the minimum window width", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 400, height: 500 });
  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const clippedButtons = () =>
    toolbar.evaluate((el) => {
      const bar = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll("button"))
        .filter((button) => {
          if (getComputedStyle(button).visibility === "hidden") return false;
          const box = button.getBoundingClientRect();
          return box.width > 0 && (box.right > bar.right + 1 || box.bottom > bar.bottom + 1);
        })
        .map((button) => button.getAttribute("aria-label"));
    });
  await expect.poll(clippedButtons).toEqual([]);
  const search = toolbar.getByRole("textbox", { name: "Filter by message" });
  await expect(search).toBeVisible();
  expect((await search.boundingBox())!.width).toBeGreaterThan(12);
  await toolbar.getByRole("button", { name: "View Options" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Tag Names" })).toBeVisible();
  await page.keyboard.press("Escape");
  await toolbar.getByRole("button", { name: "More Filters" }).click();
  await expect(page.getByRole("menuitem", { name: "Paths" })).toBeVisible();
});

test("Git Log puts affected changes on the changed-files toolbar and groups preview options", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.evaluate(() => {
    window.__ipc.handlers.vcs_commit_files = () => [
      { path: "src/prices.ts", oldPath: null, kind: "modified" },
      { path: "docs/checkout.md", oldPath: null, kind: "modified" },
    ];
  });
  const commit = page.getByRole("listbox", { name: "Commits" }).getByRole("option").first();
  const toolbar = page.getByRole("toolbar", { name: "Changed files" });
  const tree = page.getByRole("tree", { name: "Changed files" });
  const prices = tree.getByText("prices.ts", { exact: true });
  const notes = tree.getByText("checkout.md", { exact: true });
  const affected = toolbar.getByRole("button", { name: "Show Only Affected Changes" });
  const viewOptions = toolbar.getByRole("button", { name: "View Options" });
  const menu = page.getByRole("menu");

  await commit.click();
  await expect(notes).toBeVisible();
  await expect(affected).toHaveCount(0);

  const filter = (paths: string[]) =>
    page.evaluate(async (paths) => {
      const mod = "/src/features/vcs/logStore.ts";
      const { setLogFilters } = await import(/* @vite-ignore */ mod);
      setLogFilters({ paths });
    }, paths);
  await filter(["/dev/acme-api/src"]);
  await commit.click();
  await expect(affected).toHaveAttribute("aria-pressed", "false");
  await affected.press("Space");
  await expect(affected).toHaveAttribute("aria-pressed", "true");
  await expect(prices).toBeVisible();
  await expect(notes).toHaveCount(0);

  await page.setViewportSize({ width: 490, height: 550 });
  await expect(affected).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      toolbar.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return [...el.querySelectorAll("button")].every((button) => {
          const box = button.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom;
        });
      }),
    )
    .toBe(true);
  await viewOptions.click();
  await expect(menu.getByText("Layout", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Show Only Affected Changes" })).toHaveCount(0);
  const preview = menu.getByRole("menuitemcheckbox", { name: "Show Diff Preview" });
  await expect(preview).toHaveAttribute("aria-checked", "true");
  await preview.click();
  await viewOptions.click();
  await expect(preview).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await affected.click();
  await expect(notes).toBeVisible();

  await filter([]);
  await commit.click();
  await expect(affected).toHaveCount(0);
  await expect(notes).toBeVisible();
});

test("the Paths filter replaces the repository filter and can be cleared from overflow", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    const root = "/dev/acme-api";
    const other = "/dev/tools";
    const branch = (name: string) => ({
      name,
      current: true,
      remote: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommitMs: 0,
      commit: "",
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_branches = ({ repo }) => [branch(repo === other ? "tools-main" : "api-main")];
    useVcs.setState({ roots: [root, other], branches: [branch("api-main")] });
    handlers.fs_read_dir = ({ path }) =>
      path === root ? [{ name: "api.ts", path: root + "/api.ts", kind: "file", size: 0, mtimeMs: 0 }] : [];
    const log = handlers.vcs_log!;
    handlers.vcs_log = (args) => {
      const { paths } = args.query as { paths?: string[] };
      return log({ ...args, query: { ...(args.query as object), skip: paths?.includes(root + "/api.ts") ? 1 : 0 } });
    };
  });
  await page.setViewportSize({ width: 600, height: 550 });
  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const overflow = toolbar.getByRole("button", { name: "More Filters" });
  await overflow.click();
  await page.getByRole("menuitem", { name: "Paths", exact: true }).click();
  const acme = page.getByRole("menuitemcheckbox", { name: "acme-api" });
  await expect(acme).toHaveAttribute("aria-checked", "true");
  await acme.click();
  await overflow.click();
  await page.getByRole("menuitem", { name: "Paths: tools", exact: true }).click();
  await expect(acme).toHaveAttribute("aria-checked", "false");
  await page.getByRole("menuitem", { name: "Select in Tree…" }).click();
  const picker = page.getByRole("dialog", { name: "Filter by Paths" });
  const pathTree = picker.getByRole("tree", { name: "Files and folders" });
  const repo = pathTree.getByRole("checkbox", { name: "acme-api" });
  await expect(repo).toBeVisible();
  const tree = await pathTree.boundingBox();
  const row = await repo.locator("xpath=ancestor::label").boundingBox();
  expect(tree!.x + tree!.width).toBeGreaterThanOrEqual(row!.x + row!.width);
  await repo.check();
  await picker.getByRole("button", { name: "OK" }).click();
  await page.setViewportSize({ width: 1100, height: 720 });
  const branches = page.getByRole("tree", { name: "Branches", exact: true });
  await expect(branches.getByText("api-main", { exact: true })).toBeVisible();
  await expect(branches.getByText("tools-main", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 550 });

  await overflow.click();
  await page.getByRole("menuitem", { name: /^Paths:/ }).click();
  await page.getByRole("menuitem", { name: "Select in Tree…" }).click();
  await repo.uncheck();
  await repo.locator("xpath=ancestor::*[@data-row]").locator("[data-tree-toggle]").click();
  await picker.getByRole("checkbox", { name: "api.ts" }).check();
  await picker.getByRole("button", { name: "OK" }).click();
  const firstCommit = page.getByRole("listbox", { name: "Commits" }).getByRole("option").first();
  await expect(firstCommit.getByText("Commit 1", { exact: true })).toBeVisible();
  await overflow.click();
  await page.getByRole("menuitem", { name: /^Paths:/ }).click();
  await page.getByRole("menuitem", { name: "All" }).click();
  await expect(firstCommit.getByText("Commit 0", { exact: true })).toBeVisible();

  await overflow.click();
  await page.getByRole("menuitem", { name: "Paths", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "api.ts" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Select…", exact: true }).click();
  await picker.getByRole("textbox", { name: "Paths" }).fill("acme-api/api.ts");
  await picker.getByRole("button", { name: "OK" }).click();
  await expect(firstCommit.getByText("Commit 1", { exact: true })).toBeVisible();
});
