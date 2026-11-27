import { expect, stubDesktop, test } from "./fixtures";

test("file history puts commit details below the revisions and keeps directory history in the log layout", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const id = (n: number) => n.toString().padStart(40, "0");
    const commits = ["Update the reviewed totals", "Add the weekly total"].map((summary, index) => ({
      id: id(index + 1),
      shortId: id(index + 1).slice(-8),
      author: index === 0 ? "Lena Park" : "Morgan Chen",
      email: "review@example.com",
      timeMs: Date.UTC(2026, 9, 25 - index),
      parents: index === 0 ? [id(2)] : [],
      refs: [],
      summary,
      message: `${summary}\n\nRevision notes for the release review.`,
    }));
    const h = window.__ipc.handlers;
    h.fs_entry_kind = ({ path }) => (path === `${root}/src` ? "dir" : "file");
    h.vcs_log = ({ query }) => {
      const { skip, path } = query as { skip: number; path?: string };
      return commits
        .slice(skip)
        .map((c) => ({ ...c, historyPath: path?.endsWith(".kts") ? "build.gradle.kts" : null }));
    };
    h.vcs_log_refs = () => ({});
    h.vcs_branches = () => [];
    h.vcs_commit_files = () => [{ path: "build.gradle.kts", kind: "modified" }];
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map((revision) => ({
        message: commits.find((commit) => commit.id === revision)!.message,
        containingBranches: ["main"],
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
    await executeAction("vcs.showHistory", `${root}/build.gradle.kts`);
  });

  const git = page.getByRole("tablist", { name: "Git" });
  const historyTab = git.getByRole("tab", { name: /History: build.gradle.kts/ });
  const revisions = page.getByRole("listbox", { name: "Commits" });
  const separator = page.getByRole("separator", { name: "Details", exact: true });
  const details = page.getByRole("region", { name: "Commit message" });
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  const newest = revisions.getByRole("option", { name: /Update the reviewed totals/ });
  await expect(newest).toBeVisible();
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(page.getByRole("toolbar", { name: "Branches", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show Branches", exact: true })).toHaveCount(0);

  const author = await newest.getByText("Lena Park", { exact: true }).boundingBox();
  const subject = await newest.getByText("Update the reviewed totals", { exact: true }).boundingBox();
  expect(author!.x).toBeLessThan(subject!.x);
  const earlier = revisions.getByRole("option", { name: /Add the weekly total/ });
  await earlier.click();
  await expect(details).toContainText("Add the weekly total");
  await expect(details).toContainText("Revision notes for the release review.");
  const listBox = (await revisions.boundingBox())!;
  expect((await details.boundingBox())!.y).toBeGreaterThanOrEqual(listBox.y + listBox.height - 1);
  await expect(
    page.getByRole("tree", { name: "Changed files" }).getByRole("treeitem", { name: "build.gradle.kts" }),
  ).toBeVisible();

  await separator.press("ArrowUp");
  await expect.poll(async () => (await revisions.boundingBox())!.height).toBeLessThan(listBox.height);
  await expect(earlier).toHaveAttribute("aria-selected", "true");
  const resized = (await revisions.boundingBox())!.height;
  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showHistory", "/dev/acme-api/src");
  });
  await expect(git.getByRole("tab", { name: /History: src/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("toolbar", { name: "Branches", exact: true })).toBeVisible();
  await expect(separator).toHaveCount(0);

  await historyTab.click();
  await expect(earlier).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await revisions.boundingBox())!.height).toBeCloseTo(resized, 0);
  await expect(details).toContainText("Add the weekly total");
});
