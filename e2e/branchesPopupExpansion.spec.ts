/**
 * Git Branches keeps the groups the user expanded or collapsed after a restart, as IDEA does.
 * Git is stubbed at the IPC layer; reloading the page stands in for restarting the IDE.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

async function openBranches(page: Page, tags: string[] = [], hasRemotes = true) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, tags, hasRemotes }) => {
      const h = window.__ipc.handlers;
      const branch = (name: string, remote: boolean, current = false) => ({
        name,
        current,
        remote,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: null,
        commit: "1111111",
      });
      h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111", hasRemotes }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: "1111111",
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      h.vcs_status = () => [];
      h.vcs_tags = () => tags;
      h.vcs_branches = () => [
        branch("main", false, true),
        branch("develop", false),
        branch("origin/main", true),
        branch("origin/release", true),
      ];
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
      await loadBranches();
      const actionsModule = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsModule);
      await executeAction("vcs.branches");
    },
    { root: ROOT, tags, hasRemotes },
  );
  const popup = page.getByRole("dialog", { name: "Git Branches" });
  await expect(popup.getByRole("listbox", { name: "Branches" })).toBeVisible();
  return popup;
}

const group = (popup: ReturnType<Page["getByRole"]>, label: string) =>
  popup.locator("[aria-expanded]").filter({ has: popup.page().getByText(label, { exact: true }) });

test("Git Branches reopens with the groups expanded as the user left them, also after a restart", async ({
  workbench: page,
}) => {
  let popup = await openBranches(page);
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "false");
  await group(popup, "Remote").click();
  await group(popup, "Local").click();
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "true");
  await expect(group(popup, "Local")).toHaveAttribute("aria-expanded", "false");
  await expect(popup.getByText("release", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  popup = await openBranches(page);
  await expect(group(popup, "Remote")).toHaveAttribute("aria-expanded", "true");
  await expect(group(popup, "Local")).toHaveAttribute("aria-expanded", "false");
  await expect(popup.getByText("release", { exact: true })).toBeVisible();
  await expect(popup.getByText("develop", { exact: true })).toBeHidden();
});

test("Tag menus use the current remote configuration even before fetching any branches", async ({
  workbench: page,
}) => {
  const popup = await openBranches(page, ["v1"]);
  await page.evaluate(() => {
    window.__ipc.handlers.vcs_remotes = () => [{ name: "release/empty", url: "/empty.git" }];
    window.__ipc.handlers.vcs_remote = () => null;
  });
  const tags = group(popup, "Tags");
  await expect(tags).toBeVisible();
  if ((await tags.getAttribute("aria-expanded")) !== "true") await tags.click();
  await popup.getByRole("option", { name: "v1", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Push to origin", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Push to release/empty", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_remote"))
    .toMatchObject([{ repo: ROOT, op: { op: "pushTag", tag: "v1", remote: "release/empty" } }]);

  await page.evaluate(async () => {
    window.__ipc.handlers.vcs_remotes = () => [{ name: "renamed/remote", url: "/empty.git" }];
    const path = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ path);
    await executeAction("vcs.branches");
  });
  await popup.getByRole("option", { name: "v1", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Push to renamed/remote", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Push to release/empty", exact: true })).toHaveCount(0);
});

test("Fetch in Git Branches follows configured remotes and stays busy in place", async ({ workbench: page }) => {
  const popup = await openBranches(page, [], false);
  const idle = popup.getByRole("button", { name: "Fetch", exact: true });
  await expect(idle).toBeDisabled();
  const executeFetch = () =>
    page.evaluate(async () => {
      const path = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ path);
      return executeAction("vcs.fetch");
    });
  expect(await executeFetch()).toBe(false);

  await page.evaluate(async (root) => {
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111", hasRemotes: true }];
    h.vcs_remote = () =>
      new Promise((resolve) =>
        window.addEventListener("test:finish-fetch", () => resolve({ remotes: [] }), { once: true }),
      );
    const path = "/src/features/vcs/store.ts";
    const { refreshNow } = await import(/* @vite-ignore */ path);
    await refreshNow();
  }, ROOT);
  await expect(idle).toBeEnabled();
  await idle.click();
  const busy = popup.getByRole("button", { name: "Fetching…", exact: true });
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(busy).toBeFocused();
  await busy.dispatchEvent("click");
  await page.keyboard.press("Space");
  expect(await executeFetch()).toBe(false);
  expect(await ipcCalls(page, "vcs_remote")).toHaveLength(1);

  await page.evaluate(() => window.dispatchEvent(new Event("test:finish-fetch")));
  await expect(idle).toBeEnabled();
  await expect(popup).toBeVisible();
  await expect(idle).toBeFocused();
});
