import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Branch comparison reuses one editor tab and keeps both commit ranges independent", async ({
  workbench: page,
}) => {
  const branch = "feature/settlement-reconciliation-and-international-ledger-reporting";
  const current = "feature/review-quarterly-settlement-audit";
  const incomingSubject = "Keep regional settlement references stable during the report export";
  const outgoingSubject = "Preserve the audit trail for settlement retries";
  await page.setViewportSize({ width: 1120, height: 760 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ branch, current, incomingSubject, outgoingSubject }) => {
      const root = "/dev/acme-api";
      const branchInfo = {
        head: current,
        headCommit: "b".repeat(40),
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      };
      const entry = (letter: string, summary: string) => ({
        id: letter.repeat(40),
        shortId: letter.repeat(8),
        parents: ["a".repeat(40)],
        refs: [],
        summary,
        message: summary + "\n\nUpdate the audit report context.",
        author: "Sam Rivera",
        email: "sam@example.invalid",
        timeMs: 1795100000000,
      });
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, ...branchInfo }];
      h.vcs_branch_info = () => branchInfo;
      h.vcs_status = () => [];
      h.vcs_branches = () => [];
      h.vcs_log_refs = () => ({});
      h.vcs_config_get = () => null;
      h.vcs_commit_files = () => [];
      h.vcs_log_details_batch = ({ revisions }) =>
        (revisions as string[]).map(() => ({ message: "", containingBranches: [], signature: "N" }));
      h.vcs_log = ({ query }) => {
        const { ranges, skip, text } = query as { ranges: string[]; skip: number; text: string | null };
        if (skip) return [];
        const range = ranges?.[0];
        const rows =
          range === `refs/heads/${current}..refs/heads/${branch}`
            ? [entry("c", incomingSubject)]
            : range === `refs/heads/${branch}..refs/heads/${current}`
              ? [entry("b", outgoingSubject)]
              : [];
        return text ? rows.filter((commit) => commit.summary.includes(text)) : rows;
      };
      h.window_open_comparison = () => null;
      const store = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branch: branchInfo });
      const path = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ path);
      const target = { name: branch, rev: `refs/heads/${branch}` };
      await executeAction("vcs.log.compareBranches", target);
      await executeAction("vcs.log.compareBranches", target);
    },
    { branch, current, incomingSubject, outgoingSubject },
  );
  await expect(page.getByRole("tab", { name: new RegExp(`Compare ${current}`) })).toHaveCount(1);
  const incomingPane = page.getByRole("region", { name: `In ${branch}, not in ${current}` });
  const outgoingPane = page.getByRole("region", { name: `In ${current}, not in ${branch}` });
  const incoming = incomingPane.getByRole("listbox", { name: "Commits" });
  const outgoing = outgoingPane.getByRole("listbox", { name: "Commits" });
  await expect(incoming.getByText(incomingSubject, { exact: true })).toBeVisible();
  await expect(outgoing.getByText(outgoingSubject, { exact: true })).toBeVisible();
  await incoming.getByText(incomingSubject, { exact: true }).click();
  await outgoing.getByText(outgoingSubject, { exact: true }).click();
  await expect(incoming.getByRole("option", { selected: true })).toHaveCount(1);
  await expect(outgoing.getByRole("option", { selected: true })).toHaveCount(1);
  const search = incomingPane.getByRole("textbox", { name: "Filter by message" });
  await search.click();
  await search.fill("does not match");
  await expect(incoming.getByRole("option")).toHaveCount(0);
  await expect(outgoing.getByText(outgoingSubject, { exact: true })).toBeVisible();
  await search.fill("");
  await expect(incoming.getByText(incomingSubject, { exact: true })).toBeVisible();
  const divider = page.getByRole("separator", { name: "Resize branch comparison panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const start = (await divider.boundingBox())!.y;
  await divider.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeGreaterThan(start + 1);

  await page.setViewportSize({ width: 440, height: 660 });
  const heading = incomingPane.getByRole("heading", { name: new RegExp(`In ${branch}`) });
  await expect.poll(() => heading.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(incoming.getByRole("option")).toBeVisible();
  await expect(outgoing.getByRole("option")).toBeVisible();
  await page.getByRole("button", { name: "Show Branch Diff", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "window_open_comparison"))
    .toMatchObject([
      {
        comparison: {
          from: { rev: `refs/heads/${branch}` },
          to: { rev: `refs/heads/${current}` },
          repo: "/dev/acme-api",
        },
      },
    ]);
  await page.getByRole("tablist", { name: "Editor tabs" }).getByRole("button", { name: "Close Tab" }).click();
  await expect(incomingPane).toHaveCount(0);
  await expect(outgoingPane).toHaveCount(0);
  const openScopes = await page.evaluate(async () => {
    const path = "/src/features/vcs/logStore.ts";
    const { useGitLog } = await import(/* @vite-ignore */ path);
    return useGitLog.getState().logTabs.filter((tab: { comparison?: unknown }) => tab.comparison).length;
  });
  expect(openScopes).toBe(0);
});
