/**
 * The status bar's Git Branch widget (off by default, as in IDEA's New UI): switched on from the
 * status bar's context menu, it shows the branch and opens Git Branches above itself.
 */
import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
    const branch = (name: string, current = false) => ({
      name,
      current,
      remote: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommitMs: null,
      commit: "1111111",
    });
    h.vcs_roots = () => [{ root, operation: null, head: "feature/login", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({
      head: "feature/login",
      headCommit: "1111111",
      upstream: "origin/feature/login",
      ahead: 1,
      behind: 2,
      operation: null,
    });
    h.vcs_status = () => [];
    h.vcs_tags = () => [];
    h.vcs_branches = () => [branch("main"), branch("feature/login", true)];
    const storeModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ storeModule);
    h.settings_set = (args) => {
      const { key, value } = args as { key: string; value: string };
      const next = structuredClone(useProject.getState().settings ?? {}) as Record<string, unknown>;
      const path = key.split(".");
      let node = next;
      for (const seg of path.slice(0, -1)) {
        node[seg] ??= {};
        node = node[seg] as Record<string, unknown>;
      }
      node[path[path.length - 1]!] = JSON.parse(value);
      useProject.setState({ settings: next as never });
      return next;
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
});

test("Git Branch status bar widget is off by default and opens Git Branches above itself", async ({
  workbench: page,
}) => {
  const widget = page.locator('[data-status-item="vcs.statusBranch"]').getByRole("button");
  await expect(page.locator('[data-branches-widget="toolbar"]')).toContainText("feature/login");
  await expect(widget).toHaveCount(0);

  const bar = page.getByRole("contentinfo", { name: "Status bar" });
  const barBox = (await bar.boundingBox())!;
  await page.mouse.click(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2, { button: "right" });
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitemcheckbox", { name: "Git Branch", checked: false }).click();
  await expect(widget).toContainText("feature/login");
  await expect(widget.locator("svg")).not.toHaveCount(0);

  await widget.click();
  const popup = page.getByRole("dialog", { name: "Git Branches" });
  await expect(popup.getByRole("listbox", { name: "Branches" })).toBeVisible();
  await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const popupBox = (await popup.boundingBox())!;
  const widgetBox = (await widget.boundingBox())!;
  expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(widgetBox.y + 1);
  await expect(widget).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-branches-widget="toolbar"]')).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: "test-results/status-bar-git-branch.png", animations: "disabled" });
});

test("Git Branch status bar widget shows a long branch name whole", async ({ workbench: page }) => {
  const long = "feature/JIRA-12345-show-the-whole-branch-name-in-the-status-bar";
  await page.evaluate(
    async ({ root, long }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, operation: null, head: long, headCommit: "1111111" }];
      h.vcs_branch_info = () => ({
        head: long,
        headCommit: "1111111",
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      const vcsModule = "/src/features/vcs/store.ts";
      const { refreshNow } = await import(/* @vite-ignore */ vcsModule);
      await refreshNow();
    },
    { root: ROOT, long },
  );
  const bar = page.getByRole("contentinfo", { name: "Status bar" });
  const barBox = (await bar.boundingBox())!;
  await page.mouse.click(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2, { button: "right" });
  await page.getByRole("menu").getByRole("menuitemcheckbox", { name: "Git Branch", checked: false }).click();
  const widget = page.locator('[data-status-item="vcs.statusBranch"]').getByRole("button");
  await expect(widget).toContainText(long);
  const name = widget.locator("span", { hasText: long });
  // The whole name fits: the widget is no longer capped at a few characters past "feature/".
  await expect.poll(() => name.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
