import { expect, stubDesktop, test } from "./fixtures";

const rootSubject = "Start warehouse reporting";
const mergeSubject = "Merge reporting changes";
const firstSubject = "Align regional settlement totals with the warehouse ledger before monthly reconciliation closes";
const secondSubject = "Keep archived settlement adjustments in the regional audit trail after the ledger is rebuilt";

test("Git Log commit choices fit their rows and navigate by keyboard after filtering", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1040, height: 700 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ mergeSubject, firstSubject, secondSubject, rootSubject }) => {
      const root = "/dev/acme-api";
      const changes = [
        [mergeSubject, "Merge Author", [1, 2]],
        [firstSubject, "Priya Kapoor", [3]],
        [secondSubject, "Morgan Olsen", [3]],
        [rootSubject, "Initial Author", []],
      ] as const;
      const id = (i: number) => String(i + 1).repeat(40);
      const commits = changes.map(([summary, author, parents], i) => ({
        id: id(i),
        shortId: id(i).slice(0, 8),
        parents: parents.map(id),
        refs: i === 0 ? ["HEAD", "main"] : [],
        author,
        email: "author@example.com",
        timeMs: Date.UTC(2026, 10, 15 - i, 10 + i, 30),
        summary,
        message: summary,
      }));
      const handlers = window.__ipc.handlers;
      handlers.vcs_log = ({ query }) => {
        const { skip, limit, range } = query as { skip: number; limit: number; range?: string };
        return range ? [] : commits.slice(skip, limit ? skip + limit : undefined);
      };
      handlers.vcs_log_refs = () => ({});
      handlers.vcs_log_users = () => [];
      handlers.vcs_branches = () => [];
      handlers.vcs_branch_info = () => ({ head: "main", headCommit: id(0), ahead: 0, behind: 0 });
      handlers.vcs_config_get = () => null;
      handlers.vcs_commit_files = () => [];
      handlers.vcs_log_details_batch = ({ revisions }) =>
        (revisions as string[]).map(() => ({ message: "", containingBranches: [], signature: "N" }));
      const vcsModule = "/src/features/vcs/store.ts";
      const contextModule = "/src/platform/context.ts";
      const actionsModule = "/src/platform/actions.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcsModule);
      const { setContext } = await import(/* @vite-ignore */ contextModule);
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: true });
      setContext("vcsAvailable", true);
      await executeAction("vcs.showLog");
    },
    { mergeSubject, firstSubject, secondSubject, rootSubject },
  );

  const log = page.getByRole("listbox", { name: "Commits", exact: true });
  const merge = log.getByRole("option", { name: new RegExp(mergeSubject) });
  await merge.click();
  await log.press("ArrowRight");
  const chooser = page.getByRole("dialog", { name: "Select Parent Commit", exact: true });
  const options = chooser.getByRole("option");
  const filter = chooser.getByRole("combobox", { name: "Search commits" });
  await expect(filter).toBeFocused();
  await expect(options).toHaveCount(2);
  const before = (await chooser.boundingBox())!;
  expect(before.height).toBeLessThan(200);
  const first = options.filter({ hasText: firstSubject });
  const subject = first.getByText(firstSubject, { exact: true });
  const author = first.getByText("Priya Kapoor", { exact: true });
  const hash = first.getByText("22222222", { exact: true });
  await expect(subject).toHaveCSS("font-size", "13px");
  await expect(author).toHaveCSS("font-size", "12px");
  expect((await subject.boundingBox())!.y).toBeLessThan((await hash.boundingBox())!.y);
  await expect(subject.locator("..")).toHaveAttribute("title", /Priya Kapoor/);

  await page.setViewportSize({ width: 440, height: 520 });
  const narrow = (await chooser.boundingBox())!;
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(440);
  expect(await chooser.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await filter.fill("No such change");
  await expect(chooser.getByText("No commits", { exact: true })).toBeVisible();
  await filter.press("Enter");
  await expect(chooser).toBeVisible();
  await filter.fill("Morgan Olsen");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText(secondSubject);
  await filter.fill("");
  await expect(options).toHaveCount(2);
  await filter.press("ArrowDown");
  await expect(options.filter({ hasText: secondSubject })).toHaveAttribute("aria-selected", "true");
  await filter.press("Enter");
  await expect(chooser).toBeHidden();
  await expect(log.getByRole("option", { name: new RegExp(secondSubject) })).toHaveAttribute("aria-selected", "true");

  await log.getByRole("option", { name: new RegExp(rootSubject) }).click();
  await log.press("ArrowLeft");
  const children = page.getByRole("dialog", { name: "Select Child Commit", exact: true });
  await expect(children.getByRole("option")).toHaveCount(2);
  await children.getByRole("option", { name: new RegExp(firstSubject) }).click();
  await expect(children).toBeHidden();
  await expect(log.getByRole("option", { name: new RegExp(firstSubject) })).toHaveAttribute("aria-selected", "true");
});
