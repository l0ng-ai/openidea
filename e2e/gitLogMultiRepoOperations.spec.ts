import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const primary = "/dev/acme-api";
const worker = "/dev/acme-api/worker";
const tools = "/dev/acme-api/tools";
const revision = (n: string) => n.repeat(40);

async function openMixedSelection(
  page: Page,
  outcome: "success" | "failure" | "conflict" | "cancel",
  {
    addCherryPickOrigin,
    mixedOrigins = false,
    emptyAction,
  }: { addCherryPickOrigin?: boolean; mixedOrigins?: boolean; emptyAction?: "skip" | "createEmpty" } = {},
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ primary, worker, tools, outcome, addCherryPickOrigin, mixedOrigins, emptyAction }) => {
      const h = window.__ipc.handlers;
      let conflicted = false;
      const branch = (repo: unknown) => ({
        head: "main",
        headCommit: "1".repeat(40),
        operation: conflicted && repo === worker ? "cherry-pick" : null,
        upstream: null,
        ahead: 0,
        behind: 0,
      });
      h.vcs_roots = () => [primary, worker, tools].map((root) => ({ root, ...branch(root) }));
      h.vcs_branch_info = ({ repo }) => branch(repo);
      h.vcs_status = () =>
        conflicted
          ? [
              {
                path: worker + "/work.txt",
                relPath: "work.txt",
                staged: null,
                unstaged: "conflicted",
                renamedFrom: null,
              },
            ]
          : [];
      h.vcs_branches = ({ repo }) => [
        {
          name: repo === worker || (repo === primary && mixedOrigins) ? "origin/main" : "origin/feature",
          remote: true,
          current: false,
          commit: "2".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          lastCommitMs: 0,
        },
      ];
      h.vcs_log = ({ repo }) => {
        const rows: Array<[string, string, number]> =
          repo === primary
            ? [
                ["4", "Newest primary change", 4],
                ["1", "Oldest primary change", 1],
              ]
            : repo === worker
              ? [["3", "Worker change", 3]]
              : [["2", "Tools change", 2]];
        return rows.map(([n, summary, order]) => ({
          id: n.repeat(40),
          shortId: n.repeat(8),
          parents: n === "4" ? ["1".repeat(40)] : [],
          refs: [],
          author: "A",
          email: "a@example.com",
          timeMs: order * 1000,
          summary,
          message: summary,
        }));
      };
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => [];
      h.vcs_commit_files = () => [];
      h.vcs_log_details_batch = ({ repo, revisions }) =>
        (revisions as string[]).map((rev) => ({
          message: "Fixture",
          containingBranches: [
            repo === worker || (repo === primary && mixedOrigins && rev === "1".repeat(40))
              ? "origin/main"
              : "origin/feature",
          ],
          signature: "N",
          signer: "",
          key: "",
          fingerprint: "",
        }));
      h.vcs_operation = ({ repo, op, onOutput }) => {
        window.__ipc.send(onOutput, String(repo));
        if ((op as { op: string }).op === "abort") {
          conflicted = false;
          return null;
        }
        if (outcome === "failure" && repo === worker) throw { kind: "invalidInput", message: "Git stopped" };
        if (outcome === "conflict" && repo === worker) {
          conflicted = true;
          throw { kind: "invalidInput", message: "Git conflict details" };
        }
        if (outcome === "cancel" && repo === primary) {
          return new Promise<null>((resolve) => {
            h.cancel_request = () => {
              resolve(null);
              return null;
            };
          });
        }
        if (emptyAction && repo === primary && (op as { op: string }).op === "cherryPick") {
          return { emptyCherryPicks: 1, action: emptyAction };
        }
        return null;
      };
      if (addCherryPickOrigin !== undefined) {
        const projectPath = "/src/platform/project.ts";
        const { useProject } = await import(/* @vite-ignore */ projectPath);
        const { settings } = useProject.getState();
        useProject.setState({
          settings: { ...settings, vcs: { ...settings?.vcs, git: { ...settings?.vcs?.git, addCherryPickOrigin } } },
        });
      }
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root: primary, repo: primary });
      await refreshNow();
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { primary, worker, tools, outcome, addCherryPickOrigin, mixedOrigins, emptyAction },
  );
  const log = page.getByRole("listbox", { name: "Commits" });
  const newest = log.getByRole("option", { name: /Newest primary change/ });
  await newest.click();
  await log.getByRole("option", { name: /Oldest primary change/ }).click({ modifiers: ["Meta"] });
  await log.getByRole("option", { name: /Worker change/ }).click({ modifiers: ["Meta"] });
  if (outcome === "failure" || outcome === "conflict") {
    await log.getByRole("option", { name: /Tools change/ }).click({ modifiers: ["Meta"] });
  }
  await newest.click({ button: "right" });
  return page.getByRole("menu", { name: "Context menu" });
}

test("Cherry-Pick groups Git Log selections by repository and applies their commits oldest first", async ({
  workbench: page,
}) => {
  const menu = await openMixedSelection(page, "success");
  await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cherry-picked 3 commits" })).toBeVisible();
  const calls = await ipcCalls(page, "vcs_operation");
  expect(calls).toMatchObject([
    { repo: primary, op: { op: "cherryPick", recordOrigin: false, commits: [revision("1"), revision("4")] } },
    { repo: worker, op: { op: "cherryPick", recordOrigin: true, commits: [revision("3")] } },
  ]);
  expect(calls[0]?.onOutput).not.toEqual(calls[1]?.onOutput);
});

test("Revert stops after the first failed repository and reports the work already completed", async ({
  workbench: page,
}) => {
  const menu = await openMixedSelection(page, "failure");
  await menu.getByRole("menuitem", { name: "Revert Commit", exact: true }).click();
  const failure = page.getByRole("alert").filter({ hasText: "Revert failed" });
  await expect(failure).toContainText("Stopped in worker.");
  await expect(failure).toContainText("Completed in acme-api.");
  await expect(failure).toContainText("Git stopped");
  expect(await ipcCalls(page, "vcs_operation")).toMatchObject([
    { repo: primary, op: { op: "revert", commits: [revision("4"), revision("1")] } },
    { repo: worker, op: { op: "revert", commits: [revision("3")] } },
  ]);
});

test("Cherry-Pick honours the project setting to leave the source line out", async ({ workbench: page }) => {
  const menu = await openMixedSelection(page, "success", { addCherryPickOrigin: false, mixedOrigins: true });
  await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cherry-picked 3 commits" })).toBeVisible();
  const calls = await ipcCalls(page, "vcs_operation");
  expect(calls.map(({ op }) => op)).toEqual([
    { op: "cherryPick", recordOrigin: false, commits: [revision("1"), revision("4")] },
    { op: "cherryPick", recordOrigin: false, commits: [revision("3")] },
  ]);
});

test("Cherry-Pick records origins for the protected commits within a mixed repository selection", async ({
  workbench: page,
}) => {
  const menu = await openMixedSelection(page, "success", { mixedOrigins: true });
  await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cherry-picked 3 commits" })).toBeVisible();
  expect(await ipcCalls(page, "vcs_operation")).toMatchObject([
    {
      repo: primary,
      op: {
        op: "cherryPick",
        recordOrigin: false,
        recordOriginFor: [revision("1")],
        commits: [revision("1"), revision("4")],
      },
    },
    { repo: worker, op: { op: "cherryPick", recordOrigin: true, commits: [revision("3")] } },
  ]);
});

for (const [emptyAction, title, details] of [
  ["skip", "Cherry-picked 2 commits", "Skipped one empty commit"],
  ["createEmpty", "Cherry-picked 3 commits", "Created one empty commit"],
] as const) {
  test(`Cherry-Pick reports empty commits when the host selects ${emptyAction}`, async ({ workbench: page }) => {
    const menu = await openMixedSelection(page, "success", { emptyAction });
    await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: title })).toContainText(details);
  });
}

test("Cancelling a mixed Cherry-Pick prevents the next repository from starting", async ({ workbench: page }) => {
  const menu = await openMixedSelection(page, "cancel");
  await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_operation")).toHaveLength(1);
  const running = page.getByRole("status").filter({ hasText: "Cherry-picking…" });
  await running.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Git operation cancelled" })).toContainText(
    "Completed in acme-api.",
  );
  expect(await ipcCalls(page, "vcs_operation")).toHaveLength(1);
});

test("A Cherry-Pick conflict reports partial progress and aborts only the affected repository", async ({
  workbench: page,
}) => {
  const menu = await openMixedSelection(page, "conflict");
  await menu.getByRole("menuitem", { name: "Cherry-Pick", exact: true }).click();
  const conflicts = page.getByRole("dialog", { name: "Conflicts" });
  await expect(conflicts).toBeVisible();
  const warning = page.getByRole("status").filter({ hasText: "Cherry-pick has conflicts" });
  await expect(warning).toContainText("Stopped in worker.");
  await expect(warning).toContainText("Completed in acme-api.");
  await expect(warning).not.toContainText("Git conflict details");
  await conflicts.getByRole("button", { name: "Close", exact: true }).last().click();
  await warning.getByRole("button", { name: "Abort", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([
      { repo: primary, op: { op: "cherryPick" } },
      { repo: worker, op: { op: "cherryPick" } },
      { repo: worker, op: { op: "abort", expected: "cherry-pick" } },
    ]);
});
