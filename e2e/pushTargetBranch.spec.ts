/**
 * Push dialog: the target branch field completes what is typed from the branches the
 * chosen remote already has, so an existing remote branch need not be spelled out in
 * full. Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const HUGE = `feature/wrap-${"x".repeat(140)}`;

const OUTGOING = "Apply order-level discounts before calculating checkout taxes";

async function openPushDialog(page: Page, { outgoing = false, multi = false } = {}) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, outgoing, multi, subject }) => {
      const h = window.__ipc.handlers;
      const head = multi ? "feature/refine-checkout-pricing-and-order-summary-for-regional-release" : "main";
      const roots = multi ? [root, `${root}/billing-and-refunds`] : [root];
      h.vcs_roots = () => roots.map((root) => ({ root, operation: null, head, headCommit: "1111111" }));
      h.vcs_branch_info = () => ({
        head,
        headCommit: "1111111",
        upstream: `origin/${head}`,
        ahead: outgoing ? 1 : 0,
        behind: 0,
        operation: null,
      });
      h.vcs_status = () => [];
      h.vcs_log = () =>
        outgoing
          ? [
              {
                id: "2222222",
                shortId: "2222222",
                parents: ["1111111"],
                summary: subject,
                message: subject + "\n\nKeep the new totals consistent with receipts.",
                author: "Sam Rivera",
                email: "sam@example.com",
                timeMs: 1795100000000,
              },
            ]
          : [];
      h.vcs_commit_files = () => [{ path: "checkout.ts", oldPath: null, kind: "modified" }];
      h.vcs_has_hook = () => false;
      h.vcs_remotes = () => [{ name: "origin", url: "git@example.com:acme/api.git" }];
      h.vcs_push_target_choices = () => ({ branch: head, destination: null, destinations: [] });
      const branch = (name: string, remote: boolean, upstream: string | null = null) => ({
        name,
        remote,
        current: !remote,
        upstream,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      });
      h.vcs_branches = () => [
        branch("main", false, "origin/main"),
        branch("feature/login", false),
        branch("origin/main", true),
        branch("origin/feature/login", true),
        branch("origin/fix/error-auth", true),
        branch("origin/feature/PLATFORM-12345-order-history-export", true),
        branch(`origin/feature/wrap-${"x".repeat(140)}`, true),
      ];
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      void executeAction("vcs.push");
    },
    { root: ROOT, outgoing, multi, subject: OUTGOING },
  );
  const dialog = page.getByRole("dialog", { name: /Push/ });
  const input = multi
    ? dialog.getByRole("combobox", { name: "Target branch of acme-api" })
    : dialog.getByRole("combobox", { name: "Target branch" });
  await expect(input).toBeVisible();
  return { dialog, input };
}

test("typing part of a remote branch name lists the matching branches", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("fo");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  // A contiguous match ("platFOrm") first, then the looser ones in their order.
  await expect(list.getByRole("option")).toHaveText([
    "feature/PLATFORM-12345-order-history-export",
    "feature/login",
    "fix/error-auth",
  ]);
});

test("picking a branch from the list fills the field in", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("error");
  await page.getByRole("option", { name: "fix/error-auth" }).click();
  await expect(input).toHaveValue("fix/error-auth");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toHaveCount(0);
});

test("a name the remote does not have stays usable as free text", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("release/3.0");
  await expect(page.getByText("No matching remote branches")).toBeVisible();
  await expect(input).toHaveValue("release/3.0");
});

test("a long branch name widens the list instead of being cut off", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("PLATFORM");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  const option = list.getByRole("option", { name: "feature/PLATFORM-12345-order-history-export" });
  await expect(option).toBeVisible();
  // The popup grew past the field's 220px, and the row shows its whole name.
  expect((await list.boundingBox())!.width).toBeGreaterThan(220);
  expect(
    await option.evaluate((el) => {
      const name = el.querySelector('[class*="targetName"]');
      return name ? name.scrollWidth > name.clientWidth + 1 : true;
    }),
  ).toBe(false);
});

test("an extremely long name is capped and keeps the full text as a tooltip", async ({ workbench: page }) => {
  const { input } = await openPushDialog(page);
  await input.fill("wrap");
  const list = page.getByRole("listbox", { name: "Remote branches" });
  await expect(list).toBeVisible();
  const option = list.getByRole("option", { name: HUGE });
  // The name is cut off, so the row carries it as a tooltip.
  await expect(option.getByTitle(HUGE)).toHaveCount(1);
  expect((await list.boundingBox())!.width).toBeLessThanOrEqual(640);
  expect(
    await option.evaluate((el) => {
      const name = el.querySelector('[class*="targetName"]');
      return name ? name.scrollWidth > name.clientWidth : false;
    }),
  ).toBe(true);
});

test("Escape closes the list but keeps the dialog", async ({ workbench: page }) => {
  const { dialog, input } = await openPushDialog(page);
  await input.fill("f");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toBeVisible();
  await input.press("Escape");
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("Push keeps commit subjects and changed files readable in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1140, height: 760 });
  const { dialog, input } = await openPushDialog(page, { outgoing: true });
  const outgoing = dialog.getByRole("listbox", { name: "Outgoing commits" });
  const files = dialog.getByRole("tree", { name: "Changed files" });
  const commit = outgoing.getByRole("option", { name: new RegExp(OUTGOING) });
  await commit.click();
  await expect(files.getByText("checkout.ts")).toBeVisible();
  const filesBelowCommits = async () => {
    const [list, tree] = await Promise.all([outgoing.boundingBox(), files.boundingBox()]);
    return !!list && !!tree && tree.y >= list.y + list.height;
  };
  await expect.poll(filesBelowCommits).toBe(false);

  await page.setViewportSize({ width: 540, height: 630 });
  await expect.poll(filesBelowCommits).toBe(true);
  await expect(commit).toHaveAttribute("aria-selected", "true");
  const subject = commit.getByText(OUTGOING, { exact: true });
  await expect(subject).toHaveAttribute("title", /Sam Rivera/);
  await expect.poll(() => subject.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(input).toHaveValue("main");
  await expect(dialog.getByRole("button", { name: "Push", exact: true })).toBeInViewport();
  const details = dialog.getByRole("region", { name: "Commit details" });
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        editor: { ...settings?.editor, fontFamily: "Consolas", fontSize: 18, fontWeight: 400, boldFontWeight: 700 },
      },
    });
  });
  const messageSubject = details.getByText(OUTGOING, { exact: true });
  const messageBody = details.getByText("Keep the new totals consistent with receipts.", { exact: true });
  await expect(messageSubject).toHaveCSS("font-weight", "700");
  await expect(messageBody).toHaveCSS("font-weight", "400");
  await expect(messageSubject).toHaveCSS("font-size", "18px");
  await expect(messageBody).toHaveCSS("font-size", "18px");
  await expect(messageBody).toHaveCSS("font-family", /Consolas/);
  const metadata = details.getByText(/Sam Rivera <sam@example\.com>/);
  await expect(metadata).toHaveCSS("font-size", "12px");
  await metadata.scrollIntoViewIfNeeded();
  await expect(metadata).toBeInViewport();
  expect(await details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const [tree, message] = await Promise.all([files.boundingBox(), details.boundingBox()]);
      return !!tree && !!message && message.y >= tree.y + tree.height;
    })
    .toBe(true);
});

test("Push keeps per-repository targets editable with long source branches", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 475, height: 620 });
  const { dialog, input } = await openPushDialog(page, { outgoing: true, multi: true });
  const other = dialog.getByRole("combobox", { name: "Target branch of billing-and-refunds" });
  for (const field of [input, other]) {
    await expect
      .poll(() =>
        field.evaluate((target) => {
          const row = target.closest('[role="treeitem"]')!.getBoundingClientRect();
          const bounds = target.getBoundingClientRect();
          return bounds.width >= 42 && bounds.left >= row.left && bounds.right <= row.right;
        }),
      )
      .toBe(true);
  }
  await input.fill("release/checkout");
  await expect(input).toHaveValue("release/checkout");
  await expect(other).toHaveValue(/^feature\//);
  await expect(dialog.getByRole("checkbox", { name: "acme-api" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Push tags:" })).toBeInViewport();
});

test("selecting a completion in a repository row keeps the Push dialog open", async ({ workbench: page }) => {
  const { dialog, input } = await openPushDialog(page, { multi: true });
  const other = dialog.getByRole("combobox", { name: "Target branch of billing-and-refunds" });
  const otherTarget = await other.inputValue();
  await input.fill("error");
  await expect(page.getByRole("option", { name: "fix/error-auth" })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("fix/error-auth");
  await expect(other).toHaveValue(otherTarget);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Remote branches" })).toHaveCount(0);
});
