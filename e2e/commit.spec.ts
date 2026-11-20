/**
 * Committing from the Commit tool window. Git is stubbed at the IPC layer; the repository side is
 * covered by `crates/ide-vcs` against real repositories.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

/** A repository with a modified tracked file and an untracked one; `vcs_commit` clears both. */
async function stubRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    let committed = false;
    const changes = [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      { path: `${root}/notes.txt`, relPath: "notes.txt", staged: null, unstaged: "untracked", renamedFrom: null },
    ];
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111" }];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => (committed ? [] : changes);
    h.vcs_stage = () => null;
    h.vcs_unstage = () => null;
    h.vcs_config_get = () => "configured";
    h.vcs_commit = () => {
      committed = true;
      return "2222222";
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

test("⌘K commits the checked changes with the typed message", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const commit = panel.getByRole("button", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });
  // Tracked changes start included; unversioned files start excluded.
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeChecked();
  await expect(changes.getByRole("checkbox", { name: "Include Unversioned Files in commit" })).not.toBeChecked();
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();

  // Committing without a message is refused.
  await commit.click();
  await expect(panel.getByRole("alert")).toHaveText("Specify commit message");
  expect(await ipcCalls(page, "vcs_commit")).toHaveLength(0);

  await message.fill("Return order DTOs from create");
  await commit.click();
  await expect(page.getByText(/1 file committed: Return order DTOs from create/)).toBeVisible();
  const [committed] = await ipcCalls(page, "vcs_commit");
  expect(committed).toMatchObject({ repo: ROOT, message: "Return order DTOs from create" });
  // The commit takes the checked file itself; the index isn't staged beforehand.
  expect((committed!.options as { stage: string[] }).stage).toEqual([`${ROOT}/build.gradle.kts`]);
  expect(await ipcCalls(page, "vcs_stage")).toHaveLength(0);
  await expect(changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});

test("turning off default inclusion starts Commit with all files unchecked", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const label = "Include changes in the commit by default";
  await settings.getByRole("textbox", { name: "Search settings" }).fill(label);
  await settings.getByRole("treeitem", { name: "Commit", exact: true }).click();
  const toggle = settings.getByRole("checkbox", { name: label, exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).not.toBeVisible();

  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });
  const tracked = changes.getByRole("checkbox", { name: "Include build.gradle.kts in commit" });
  await expect(tracked).toHaveAttribute("aria-checked", "false");
  await expect(changes.getByRole("checkbox", { name: "Include Unversioned Files in commit" })).not.toBeChecked();
  await tracked.click();
  await expect(tracked).toBeChecked();
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Commit the selected file");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_commit")).toHaveLength(1);
  const [committed] = await ipcCalls(page, "vcs_commit");
  expect(committed!.options).toMatchObject({ stage: [`${ROOT}/build.gradle.kts`] });
});

test("commit message history opens above the message without an empty icon column", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const message = page.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeVisible();
  await page.evaluate((root) => {
    localStorage.setItem(`openidea.vcs.commitMessages:${root}`, JSON.stringify(["Previous commit message"]));
  }, ROOT);
  await message.fill("Draft");
  await page.getByRole("button", { name: "Commit Message History" }).click();

  const menu = page.getByRole("menu", { name: "Recent commit messages" });
  const row = menu.getByRole("menuitem", { name: "Previous commit message" });
  await expect(row).toBeVisible();
  const messageBox = await message.boundingBox();
  const menuBox = await menu.locator("..").boundingBox();
  expect(messageBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThan(messageBox!.y);
  expect(Math.abs(menuBox!.x - messageBox!.x)).toBeLessThan(2);
  await expect(row.locator("span")).toHaveCount(1);
});

test("the Commit changes toolbar fits a narrow side pane", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(/* @vite-ignore */ path);
    layout.moveToolWindow("commit", "left");
    layout.setToolWindowSize("left", 164);
  });
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const toolbar = panel.getByRole("toolbar", { name: "Changes" });
  await expect(toolbar).toBeVisible();
  const clipped = await toolbar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    return [...bar.querySelectorAll("button")].flatMap((button) => {
      const box = button.getBoundingClientRect();
      return box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1 ? [button.ariaLabel] : [];
    });
  });
  expect(clipped).toEqual([]);
  const push = panel.getByRole("button", { name: "Commit and Push…" });
  const overflow = await push.locator("span").evaluate((label) => label.scrollWidth - label.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await toolbar.getByRole("button", { name: "Collapse All" }).click();
  await expect(panel.getByRole("checkbox", { name: "Include build.gradle.kts in commit" })).toBeHidden();
});

test("the commit message uses the configured editor typography", async ({ workbench: page }) => {
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const message = page.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        editor: {
          ...settings?.editor,
          fontFamily: "Fira Code",
          fallbackFont: "Maple Mono NF CN",
          fontSize: 17,
          lineHeight: 28,
          fontWeight: 500,
        },
      },
    });
  });
  await expect(message).toHaveCSS("font-size", "17px");
  await expect(message).toHaveCSS("line-height", "28px");
  await expect(message).toHaveCSS("font-weight", "500");
  await expect(message).toHaveCSS("font-family", /"Fira Code".*"Maple Mono NF CN"/);
});
