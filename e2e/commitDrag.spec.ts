/**
 * Dragging an unversioned file onto a changelist in the Commit tool window: it is
 * added to Git (IDEA's Unversioned Files behaviour) and joins that list.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

/** A repository with a modified tracked file and an untracked one; staging tracks the latter. */
async function stubRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    let staged = false;
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
    h.vcs_status = () => [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      {
        path: `${root}/notes.txt`,
        relPath: "notes.txt",
        staged: staged ? "added" : null,
        unstaged: staged ? null : "untracked",
        renamedFrom: null,
      },
    ];
    h.vcs_stage = () => {
      staged = true;
      return null;
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

test("dragging an unversioned file onto a changelist adds it to Git", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubRepository(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });

  // Unversioned Files starts collapsed.
  await changes
    .getByRole("treeitem", { name: /Unversioned Files/ })
    .locator("[data-tree-toggle]")
    .click();
  const source = changes.getByText("notes.txt", { exact: true });
  await expect(source).toBeVisible();
  const target = changes.getByText("Changes", { exact: true }).first();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();

  // The drop adds the file to Git instead of only moving a changelist assignment.
  await expect.poll(async () => (await ipcCalls(page, "vcs_stage")).length).toBe(1);
  expect((await ipcCalls(page, "vcs_stage"))[0]).toMatchObject({ paths: [`${ROOT}/notes.txt`] });

  // It is versioned now: the Unversioned Files group is gone and the file stays under Changes.
  await expect(changes.getByRole("treeitem", { name: /Unversioned Files/ })).toHaveCount(0);
  await expect(changes.getByRole("treeitem", { name: /notes\.txt/ })).toBeVisible();
});

test("dragging one changelist onto another moves all of its files (PyCharm style)", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async (root) => {
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
    h.vcs_status = () => [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      {
        path: `${root}/settings.gradle.kts`,
        relPath: "settings.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
    ];

    const listsPath = "/src/features/vcs/changelists.ts";
    const { initialChangelists, useChangelists } = await import(/* @vite-ignore */ listsPath);
    const state = initialChangelists();
    state.lists.push({ id: "dd", name: "dd", comment: "" });
    state.files = { "build.gradle.kts": "default", "settings.gradle.kts": "default" };
    useChangelists.setState({ state, root, loaded: true });

    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);

  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("region", { name: "Commit", exact: true }).getByRole("tree", { name: "Changes" });
  const source = changes.getByRole("treeitem", { name: /Changes/ }).first();
  const target = changes.getByRole("treeitem", { name: /dd/ }).first();
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const listsPath = "/src/features/vcs/changelists.ts";
        const { useChangelists } = await import(/* @vite-ignore */ listsPath);
        return useChangelists.getState().state.files;
      }),
    )
    .toEqual({ "build.gradle.kts": "dd", "settings.gradle.kts": "dd" });
});

/** A repository with two untracked files; staging flips both to `added`. */
async function stubUnversionedRepository(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const staged = new Set<string>();
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
    h.vcs_status = () => [
      {
        path: `${root}/build.gradle.kts`,
        relPath: "build.gradle.kts",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
      ...["notes.txt", "todo.txt"].map((rel) => ({
        path: `${root}/${rel}`,
        relPath: rel,
        staged: staged.has(rel) ? "added" : null,
        unstaged: staged.has(rel) ? null : "untracked",
        renamedFrom: null,
      })),
    ];
    h.vcs_stage = (args: Record<string, unknown>) => {
      const paths = (args.paths as string[] | undefined) ?? [];
      for (const p of paths) staged.add(p.slice(root.length + 1));
      return null;
    };
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  }, ROOT);
}

async function changelistFiles(page: Page) {
  return page.evaluate(async () => {
    const listsPath = "/src/features/vcs/changelists.ts";
    const { useChangelists } = await import(/* @vite-ignore */ listsPath);
    return useChangelists.getState().state.files;
  });
}

async function dragTree(page: Page, from: { x: number; y: number; width: number; height: number }, to: typeof from) {
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("dragging the Unversioned Files header onto a changelist adds all of them", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubUnversionedRepository(page);
  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("region", { name: "Commit", exact: true }).getByRole("tree", { name: "Changes" });

  const source = changes.getByRole("treeitem", { name: /Unversioned Files/ });
  const target = changes.getByRole("treeitem", { name: /Changes/ }).first();
  await expect(source).toBeVisible();
  await dragTree(page, (await source.boundingBox())!, (await target.boundingBox())!);

  // Every unversioned file is added to Git and joins the list.
  await expect
    .poll(() => ipcCalls(page, "vcs_stage").then((calls) => calls.flat()))
    .toEqual([{ paths: [`${ROOT}/notes.txt`, `${ROOT}/todo.txt`] }]);
  await expect.poll(() => changelistFiles(page)).toEqual({ "notes.txt": "default", "todo.txt": "default" });
  await expect(changes.getByRole("treeitem", { name: /Unversioned Files/ })).toHaveCount(0);
});

test("dragging selected unversioned files onto a changelist adds exactly them", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubUnversionedRepository(page);
  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("region", { name: "Commit", exact: true }).getByRole("tree", { name: "Changes" });

  // Unversioned Files starts collapsed.
  await changes
    .getByRole("treeitem", { name: /Unversioned Files/ })
    .locator("[data-tree-toggle]")
    .click();

  const notes = changes.getByText("notes.txt", { exact: true });
  const todo = changes.getByText("todo.txt", { exact: true });
  const target = changes.getByRole("treeitem", { name: /Changes/ }).first();
  await expect(notes).toBeVisible();
  await expect(todo).toBeVisible();

  const notesBox = (await notes.boundingBox())!;
  // Select notes, then shift-click todo for a range selection (a press-drag
  // between the two would start a file drag instead of selecting).
  await page.mouse.click(notesBox.x + 10, notesBox.y + notesBox.height / 2);
  await todo.click({ modifiers: ["Shift"] });
  const selected = (await todo.boundingBox())!;

  await dragTree(page, selected, (await target.boundingBox())!);

  // Only the two selected files are added; the drag payload names both.
  await expect
    .poll(() => ipcCalls(page, "vcs_stage").then((calls) => calls.flat()))
    .toEqual([{ paths: [`${ROOT}/notes.txt`, `${ROOT}/todo.txt`] }]);
  await expect.poll(() => changelistFiles(page)).toEqual({ "notes.txt": "default", "todo.txt": "default" });
});
