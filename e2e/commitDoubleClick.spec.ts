/**
 * Double-click in the changes tree: the diff or the source file, from the Show on Double-Click
 * menu, the modal Commit dialog and the non-modal Commit window defaults. Git is stubbed at the IPC layer.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = "build.gradle.kts";
/** Opened before stubbing so the file under test has no editor tab until a double-click. */
const PRELOADED = "settings.gradle.kts";

/** A repository with one modified tracked file; the diff's HEAD side is a stubbed text. */
async function stubRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const changes = [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
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
    h.vcs_status = () => changes;
    h.vcs_file_at = () => "plugins {}\n";
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

/**
 * Settings writes land in the project store the way the backend answers `settings_set`: the dotted
 * key is set, `null` removes it, and the store takes the returned settings.
 */
async function stubSettingsWrites(page: Page) {
  await page.evaluate(async () => {
    const storeModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ storeModule);
    window.__ipc.handlers.settings_set = (args) => {
      const { key, value } = args as { key: string; value: string };
      const next = structuredClone(useProject.getState().settings ?? {}) as Record<string, unknown>;
      const path = key.split(".");
      let node = next;
      for (const seg of path.slice(0, -1)) {
        node[seg] ??= {};
        node = node[seg] as Record<string, unknown>;
      }
      const last = path[path.length - 1]!;
      const parsed: unknown = JSON.parse(value);
      if (parsed === null) delete node[last];
      else node[last] = parsed;
      useProject.setState({ settings: next as never });
      return next;
    };
  });
}

/** Sets a commit setting in the store directly, before the window that reads it opens. */
async function setCommitSetting(page: Page, key: "nonModal" | "doubleClickOpensDiff", value: boolean | null) {
  await page.evaluate(
    async ({ key, value }) => {
      const storeModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ storeModule);
      const next = structuredClone(useProject.getState().settings ?? {}) as Record<string, unknown>;
      const vcs = (next.vcs ??= {}) as Record<string, Record<string, unknown>>;
      const commit = (vcs.commit ??= {});
      if (value === null) delete commit[key];
      else commit[key] = value;
      useProject.setState({ settings: next as never });
    },
    { key, value },
  );
}

const diffTab = (page: Page) => page.getByRole("tab", { name: `${FILE} (HEAD ↔ Your version)` });
const sourceTab = (page: Page) =>
  page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: FILE, exact: true });

async function openCommitWindow(page: Page) {
  await openFromTree(page, PRELOADED);
  await stubRepository(page);
  await stubSettingsWrites(page);
  await page.keyboard.press("Meta+k");
  return page.getByRole("region", { name: "Commit", exact: true });
}

async function doubleClickChange(panel: Locator) {
  await panel.getByRole("tree", { name: "Changes" }).getByText(FILE, { exact: true }).dblclick();
}

async function pickDoubleClickMode(page: Page, panel: Locator, mode: string) {
  await panel.getByRole("button", { name: "View Options" }).click();
  await page.getByRole("menuitem", { name: "Show on Double-Click" }).hover();
  const item = page.getByRole("menuitemcheckbox", { name: mode, exact: true });
  await item.click();
  await expect(item).toBeHidden();
}

test("non-modal Commit window: double-click opens the diff by default", async ({ workbench: page }) => {
  const panel = await openCommitWindow(page);
  await expect(panel.getByRole("textbox", { name: "Commit message" })).toBeFocused();
  await doubleClickChange(panel);
  await expect(diffTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(sourceTab(page)).toHaveCount(0);
});

test("Show on Double-Click → Source opens the file itself, and Follow the Interface restores the diff", async ({
  workbench: page,
}) => {
  const panel = await openCommitWindow(page);
  await pickDoubleClickMode(page, panel, "Source");
  await doubleClickChange(panel);
  await expect(sourceTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(diffTab(page)).toHaveCount(0);

  await pickDoubleClickMode(page, panel, "Follow the Interface");
  await doubleClickChange(panel);
  await expect(diffTab(page)).toHaveAttribute("aria-selected", "true");
});

test("modal Commit dialog: double-click opens the diff in a front window, not an editor tab", async ({
  workbench: page,
}) => {
  await openFromTree(page, PRELOADED);
  await stubRepository(page);
  await stubSettingsWrites(page);
  await setCommitSetting(page, "nonModal", false);
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Commit Changes" });
  await expect(dialog).toBeVisible();
  await doubleClickChange(dialog);
  await expect(page.getByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).toBeVisible();
  await expect(sourceTab(page)).toHaveCount(0);
  await expect(diffTab(page)).toHaveCount(0);
});
