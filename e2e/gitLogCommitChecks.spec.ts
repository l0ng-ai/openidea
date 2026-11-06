import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("shows GitHub check statuses for each commit's repository", async ({ workbench: page }) => {
  await page.clock.install();
  await stubDesktop(page);
  await page.evaluate(async () => {
    const primary = "/dev/acme-api";
    const linked = "/dev/acme-web";
    const tip = "1".repeat(40);
    const pending = "2".repeat(40);
    const missing = "3".repeat(40);
    const h = window.__ipc.handlers;
    h.vcs_roots = () =>
      [
        { root: primary, head: "main" },
        { root: linked, head: "release" },
      ].map((repo) => ({ ...repo, operation: null, headCommit: tip }));
    h.vcs_branch_info = ({ repo }) => ({
      head: repo === linked ? "release" : "main",
      headCommit: tip,
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_branches = ({ repo }) =>
      [repo === linked ? "origin/dev" : "origin/other"].map((name) => ({
        name,
        commit: tip,
        remote: true,
        current: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
      }));
    h.vcs_log = ({ repo }) => {
      const rows: [string, string][] =
        repo === linked
          ? [[tip, "Linked repository commit"]]
          : [
              [tip, "Primary repository commit"],
              [pending, "Pending commit"],
              [missing, "Local-only commit"],
            ];
      return rows.map(([id, summary], i) => ({
        id,
        shortId: id.slice(0, 8),
        parents: [],
        refs: i === 0 ? [repo === linked ? "origin/dev" : "origin/other"] : [],
        author: "A",
        email: "a@example.com",
        timeMs: 0,
        summary,
        message: summary,
      }));
    };
    h.vcs_log_refs = () => ({});
    h.vcs_log_details_batch = ({ revisions }) =>
      (revisions as string[]).map(() => ({
        message: "Linked repository commit",
        containingBranches: [],
        signature: "N",
        signer: "",
        key: "",
        fingerprint: "",
      }));
    h.vcs_commit_files = () => [];
    h.vcs_config_get = () => null;
    h.vcs_tags = () => [];
    h.vcs_status = () => [];
    h.vcs_remotes = ({ repo }) => [
      { name: "origin", url: `git@github.com:example/${repo === linked ? "web" : "api"}.git` },
    ];
    let pendingQueries = 0;
    h.gh_api = ({ repo, request }) => {
      const { variables } = JSON.parse((request as { body: string }).body) as { variables: Record<string, string> };
      const linkedRepo = repo === linked;
      const state = linkedRepo ? "FAILURE" : "SUCCESS";
      if (variables.oid)
        return JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ __typename: "StatusContext", context: "Frontend", state, targetUrl: null }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        });
      const statuses = Object.entries(variables)
        .filter(([key]) => /^oid\d+$/.test(key))
        .map(([key, revision]) => [
          key.replace("oid", "c"),
          revision === missing
            ? null
            : { statusCheckRollup: { state: revision === pending && ++pendingQueries === 1 ? "PENDING" : state } },
        ]);
      return JSON.stringify({ data: { repository: Object.fromEntries(statuses) } });
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root: primary, repo: primary });
    await refreshNow();
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.showLog");
  });

  const primary = page.getByRole("option", { name: /Primary repository commit/ });
  const linked = page.getByRole("option", { name: /Linked repository commit/ });
  await expect(primary).toBeVisible();
  expect(await ipcCalls(page, "gh_api")).toEqual([]);
  await page.getByRole("button", { name: "View Options" }).first().click();
  await page.getByRole("menuitem", { name: "Columns", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: "GitHub Commit Checks" }).click({ timeout: 4000 });
  await expect(primary.getByRole("button", { name: "Checks passed" })).toBeVisible();
  await expect(linked.getByRole("button", { name: "Checks failed" })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Pending commit/ }).getByRole("button", { name: "Checks in progress…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Local-only commit/ }).getByRole("button", { name: /^Checks / }),
  ).toHaveCount(0);

  const calls = await ipcCalls(page, "gh_api");
  expect(calls.map((c) => c.repo).sort()).toEqual(["/dev/acme-api", "/dev/acme-web"]);
  expect(calls.map((c) => JSON.parse((c.request as { body: string }).body).variables.repoName).sort()).toEqual([
    "api",
    "web",
  ]);
  await linked.getByRole("button", { name: "Checks failed" }).click();
  await expect(page.getByRole("option", { name: /Frontend/ })).toBeVisible();
  expect((await ipcCalls(page, "gh_api")).at(-1)).toMatchObject({ repo: "/dev/acme-web" });

  await page.keyboard.press("Escape");
  await page.clock.fastForward(31_000);
  await expect(
    page.getByRole("option", { name: /Pending commit/ }).getByRole("button", { name: "Checks passed" }),
  ).toBeVisible();
});
