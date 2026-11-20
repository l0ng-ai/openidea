import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Branch comparison keeps both commit ranges and the diff action visible", async ({ workbench: page }) => {
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
      h.vcs_log = ({ query }) =>
        (query as { range: string }).range === `HEAD..${branch}`
          ? [entry("c", incomingSubject)]
          : [entry("b", outgoingSubject)];
      h.window_open_comparison = () => null;
      const store = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branch: branchInfo });
      const path = "/src/features/vcs/CompareBranches.tsx";
      (await import(/* @vite-ignore */ path)).showCompareBranches(branch);
    },
    { branch, current, incomingSubject, outgoingSubject },
  );
  const dialog = page.getByRole("dialog", { name: new RegExp(`Compare ${current}`) });
  await expect(dialog.getByRole("listbox")).toHaveCount(2);
  const incoming = dialog.getByRole("listbox", { name: `In ${branch}, not in ${current}` });
  const outgoing = dialog.getByRole("listbox", { name: `In ${current}, not in ${branch}` });
  await expect(incoming.getByText(incomingSubject, { exact: true })).toBeVisible();
  await expect(outgoing.getByText(outgoingSubject, { exact: true })).toBeVisible();
  const divider = dialog.getByRole("separator", { name: "Resize branch comparison panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const start = (await divider.boundingBox())!.y;
  await divider.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeGreaterThan(start + 1);

  await page.setViewportSize({ width: 440, height: 660 });
  const heading = dialog.getByRole("heading", { name: new RegExp(`In ${branch}`) });
  await expect.poll(() => heading.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(incoming.getByRole("option")).toBeVisible();
  await expect(outgoing.getByRole("option")).toBeVisible();
  await dialog.getByRole("button", { name: "Show Diff", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "window_open_comparison"))
    .toMatchObject([{ comparison: { from: { rev: branch }, to: { rev: "HEAD" }, repo: "/dev/acme-api" } }]);
});
