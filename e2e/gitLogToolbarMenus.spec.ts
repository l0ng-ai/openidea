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

test("compact Git Log refs give the subject room on either side", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 630, height: 720 });
  const refSubject = "Reconcile shipping credits";
  const longReference = "release-quarterly-settlement-and-backoffice-invoice-reconciliation";
  await page.evaluate(
    async ({ refSubject, longReference }) => {
      const optionsModule = "/src/features/vcs/logOptions.ts";
      const logModule = "/src/features/vcs/logStore.ts";
      const { setLogOptions } = await import(/* @vite-ignore */ optionsModule);
      const { useGitLog } = await import(/* @vite-ignore */ logModule);
      setLogOptions({ showBranches: false, showDetails: false });
      const [first, ...rest] = useGitLog.getState().commits;
      useGitLog.setState({
        commits: [{ ...first, summary: refSubject, message: refSubject, refs: [longReference] }, ...rest],
      });
    },
    { refSubject, longReference },
  );
  const row = page.getByRole("listbox", { name: "Commits" }).getByRole("option").filter({ hasText: refSubject });
  const subject = row.getByText(refSubject, { exact: true });
  const ref = row.getByTitle(longReference, { exact: true });
  const expectLayout = async () => {
    await expect
      .poll(() =>
        subject.evaluate((el) => {
          const text = document.createRange();
          text.selectNodeContents(el);
          return el.getBoundingClientRect().width + 0.02 >= text.getBoundingClientRect().width;
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        ref.evaluate((el) => {
          const refs = el.parentElement!;
          return refs.clientWidth / refs.parentElement!.clientWidth;
        }),
      )
      .toBeLessThanOrEqual(0.34);
    await expect(ref).toHaveCSS("font-size", "12px");
    await expect(subject).toHaveCSS("font-size", "13px");
  };
  await expectLayout();
  await expect.poll(async () => (await subject.boundingBox())!.x < (await ref.boundingBox())!.x).toBe(true);

  await page.getByRole("toolbar", { name: "Log filters" }).getByRole("button", { name: "View Options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "References on the Left" }).click();
  await expectLayout();
  await expect.poll(async () => (await subject.boundingBox())!.x > (await ref.boundingBox())!.x).toBe(true);
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

test("long Git Log filter values shorten inside their buttons", async ({ workbench: page }) => {
  const branchName = "feature/quarterly-settlement-and-backoffice-invoice-reconciliation";
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.evaluate(async (branch) => {
    const logModule = "/src/features/vcs/logStore.ts";
    const optionsModule = "/src/features/vcs/logOptions.ts";
    const { setLogBranches } = await import(/* @vite-ignore */ logModule);
    const { setLogOptions } = await import(/* @vite-ignore */ optionsModule);
    setLogOptions({ showBranches: false, showDetails: false });
    setLogBranches([branch]);
  }, branchName);

  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const branch = toolbar.getByRole("button", { name: `Branch: ${branchName}`, exact: true });
  const value = branch.getByText(branchName, { exact: true });
  const clear = toolbar.getByRole("button", { name: "Clear Branch filter", exact: true });
  for (const width of [1120, 620]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(branch).toBeVisible();
    await expect(value).toHaveCSS("text-overflow", "ellipsis");
    expect(
      await value.evaluate((label) => {
        const bounds = label.getBoundingClientRect();
        const button = label.closest("button")!.getBoundingClientRect();
        return label.scrollWidth > label.clientWidth && bounds.width > 0 && bounds.right <= button.right;
      }),
    ).toBe(true);
    await expect(branch).toHaveAttribute("title", branchName);
    await clear.click({ trial: true });
  }

  await page.setViewportSize({ width: 400, height: 560 });
  // The overflow is measured after the resize: open the menu once the filter has moved into it.
  await expect(branch).toBeHidden();
  await toolbar.getByRole("button", { name: "More Filters" }).click();
  await expect(page.getByRole("menuitem", { name: `Branch: ${branchName}`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 620, height: 720 });
  await clear.click();
  await expect(toolbar.getByRole("button", { name: "Branch", exact: true })).toBeVisible();
  await expect(clear).toBeHidden();
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

test("Not Cherry-Picked Commits dims other rows while keeping unpicked commits readable", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    window.__ipc.handlers.vcs_not_cherry_picked = () => ["0".repeat(40)];
    const logModule = "/src/features/vcs/logStore.ts";
    const { setLogBranches } = await import(/* @vite-ignore */ logModule);
    setLogBranches(["release"]);
  });
  const rows = page.getByRole("listbox", { name: "Commits" });
  const waiting = rows.getByText("Commit 0", { exact: true });
  const picked = rows.getByText("Commit 1", { exact: true });
  const color = await waiting.evaluate((el) => getComputedStyle(el).color);
  await expect(picked).toHaveCSS("color", color);

  const view = page.getByRole("button", { name: "View Options", exact: true });
  const highlight = page.getByRole("menuitemcheckbox", { name: "Not Cherry-Picked Commits" });
  await view.click();
  await expect(highlight).toHaveAttribute("aria-checked", "false");
  await highlight.click();
  await expect(picked).not.toHaveCSS("color", color);
  await expect(waiting).toHaveCSS("color", color);

  await view.click();
  await expect(highlight).toHaveAttribute("aria-checked", "true");
  await highlight.click();
  await expect(picked).toHaveCSS("color", color);
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

test("the Git Log path tree resizes and keeps selected paths reachable in a short window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  const longName = "reconcile-invoices-and-export-the-complete-quarterly-settlement-audit.ts";
  await page.evaluate(async (longName) => {
    const logPath = "/src/features/vcs/logStore.ts";
    const optionsPath = "/src/features/vcs/logOptions.ts";
    const { setLogFilters } = await import(/* @vite-ignore */ logPath);
    const { setLogOptions } = await import(/* @vite-ignore */ optionsPath);
    const root = "/dev/acme-api";
    const selected = Array.from({ length: 9 }, (_, i) => `entry-${i + 1}.ts`);
    const entry = (name: string, kind: "dir" | "file") => ({
      name,
      path: `${root}/${name}`,
      kind,
      size: 0,
      mtimeMs: 0,
    });
    window.__ipc.handlers.fs_read_dir = ({ path }) =>
      path === root
        ? [entry("src", "dir"), entry(longName, "file"), ...selected.map((name) => entry(name, "file"))]
        : [];
    setLogOptions({ showBranches: false, showDetails: false });
    setLogFilters({ paths: selected.map((name) => `${root}/${name}`) });
  }, longName);

  const toolbar = page.getByRole("toolbar", { name: "Log filters" });
  const openTree = async () => {
    await toolbar.getByRole("button", { name: "More Filters" }).click();
    await page.getByRole("menuitem", { name: /^Paths:/ }).click();
    await page.getByRole("menuitem", { name: "Select in Tree…" }).click();
  };
  await openTree();
  const dialog = page.getByRole("dialog", { name: "Filter by Paths" });
  const tree = dialog.getByRole("tree", { name: "Files and folders" });
  const resize = dialog.locator('[class*="_resizeGrip_"]');
  await expect(tree).toBeVisible();
  await expect(resize).toBeVisible();
  await tree.getByRole("treeitem", { name: "acme-api", exact: true }).locator("[data-tree-toggle]").click();
  const folder = tree.getByRole("checkbox", { name: "src", exact: true });
  const file = tree.getByRole("checkbox", { name: longName, exact: true });
  await expect(folder.locator("xpath=ancestor::label").locator("svg")).toHaveCount(1);
  const title = file.locator("xpath=ancestor::label").getByTitle(longName);
  await expect(title).toHaveCSS("font-size", "13px");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");

  const originalTreeHeight = (await tree.boundingBox())!.height;
  const grip = (await resize.boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 65, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await tree.boundingBox())!.height).toBeGreaterThan(originalTreeHeight + 40);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ width: 420, height: 325 });
  await openTree();
  await tree.getByRole("treeitem", { name: "acme-api", exact: true }).locator("[data-tree-toggle]").click();
  const selected = dialog.getByRole("group", { name: "Selected paths" });
  await expect(selected).toBeVisible();
  await expect.poll(() => selected.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(1);
  await expect
    .poll(() => dialog.locator("[data-dialog-body]").evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeLessThanOrEqual(1);
  await expect.poll(() => title.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeGreaterThan(1);
  const removed = selected.getByRole("checkbox", { name: "acme-api/entry-9.ts", exact: true });
  await removed.click();
  await expect(removed).toHaveCount(0);
  await file.check();
  await expect(selected.getByRole("checkbox", { name: `acme-api/${longName}`, exact: true })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "OK" })).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  const applied = await page.evaluate(async () => {
    const path = "/src/features/vcs/logStore.ts";
    const { useGitLog } = await import(/* @vite-ignore */ path);
    return useGitLog.getState().filters.paths;
  });
  expect(applied).toContain(`/dev/acme-api/${longName}`);
  expect(applied).not.toContain("/dev/acme-api/entry-9.ts");
});
