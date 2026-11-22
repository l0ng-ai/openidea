import type { Page } from "@playwright/test";
import type { EditorView } from "@codemirror/view";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("edits the staged version and keeps an unsaved draft when the index changes", async ({ workbench: page }) => {
  const root = "/dev/acme-api";
  const path = `${root}/build.gradle.kts`;
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path }) => {
      let text = "val staged = 1\n";
      let version = "one";
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_staged_text = () => ({ text, version });
      h.vcs_file_at = (args) => (args.rev === ":0" ? text : "val committed = 0\n");
      h.fs_read_text = () => "val working = 4\n";
      h.vcs_diff_hunks = () => [];
      h.vcs_save_staged_text = (args) => {
        if (args.path !== path || args.version !== version) {
          throw { kind: "outOfSync", message: "The staged version changed on disk" };
        }
        text = String(args.text);
        version = "saved";
        return version;
      };
      h.test_restage = () => {
        text = "val external = 3\n";
        version = "external";
      };
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: {
          ...s.settings,
          vcs: { git: { stagingArea: true }, commit: { nonModal: true }, diffAsEditorTab: true },
        },
      }));
      const store = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, path },
  );

  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("tree", { name: "Changes", exact: true });
  const staged = changes.getByRole("treeitem", { name: "Staged Changes", exact: false }).first();
  await expect(staged).toBeVisible();
  await changes.getByText("build.gradle.kts", { exact: true }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Jump to Source/ }).click();
  const editor = page.getByRole("textbox", { name: "Staged version editor" });
  const tab = page.getByRole("tab", { name: /Staged: build\.gradle\.kts/ });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("val staged = 1");
  await editor.fill("val staged = 2\n");
  await editor.press("Meta+s");
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([{ path, text: "val staged = 2\n", version: "one" }]);
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);

  await editor.fill("val draft = 4\n");
  await page.evaluate(() => window.__ipc.handlers.test_restage?.({}));
  await editor.press("Meta+s");
  await expect(page.getByText("The staged version changed on disk", { exact: true }).first()).toBeVisible();
  await expect(editor).toContainText("val draft = 4");
  await page.getByRole("button", { name: "Reload Staged Version", exact: true }).click();
  await page.getByRole("dialog", { name: "Reload Staged Version" }).getByRole("button", { name: "Reload" }).click();
  await expect(editor).toContainText("val external = 3");

  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compare with HEAD", exact: true }).click();
  await expect(page.getByRole("tab", { name: /HEAD ↔ Staged \(index\)/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-editor:visible .cm-content").filter({ hasText: "val committed = 0" })).toBeVisible();
  await expect(page.locator(".cm-editor:visible .cm-content").filter({ hasText: "val external = 3" })).toBeVisible();

  await tab.click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compare with Local Version", exact: true }).click();
  const workingDiff = page.getByRole("tab", { name: /Staged \(index\) ↔ Local Version/ });
  await expect(workingDiff).toHaveAttribute("aria-selected", "true");
  await tab.click();

  await page.getByRole("button", { name: "Show Local Version" }).click();
  const localTab = page.getByRole("tab", { name: "build.gradle.kts", exact: true });
  await expect(localTab).toHaveAttribute("aria-selected", "true");
  await localTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compare with Staged Version", exact: true }).click();
  await expect(workingDiff).toHaveAttribute("aria-selected", "true");

  await tab.click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compare Three Versions", exact: true }).click();
  const headPane = page.locator('.cm-content[aria-label="HEAD"]:visible');
  const indexPane = page.locator('.cm-content[aria-label="Staged (index)"]:visible');
  const localPane = page.locator('.cm-content[aria-label="Local Version"]:visible');
  await expect(headPane).toContainText("val committed = 0");
  await expect(indexPane).toContainText("val external = 3");
  await expect(localPane).not.toBeEmpty();
  const working = await localPane.textContent();

  await page.getByRole("button", { name: "Unstage Change", exact: true }).click();
  await expect(indexPane).toContainText("val committed = 0");
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([
      { path, text: "val staged = 2\n", version: "one" },
      { path, text: "val draft = 4\n", version: "saved" },
      { path, text: "val committed = 0\n", version: "external" },
    ]);

  await page.getByRole("button", { name: "Stage Change (git add hunk)", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "vcs_save_staged_text")).length).toBe(4);
  await expect(indexPane).toHaveText(working ?? "");
  await expect(localPane).toHaveText(working ?? "");
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);
});

for (const comparison of ["three-way", "two-way", "local"] as const) {
  test(`shares index drafts with the ${comparison} diff and keeps them on a failed close`, async ({
    workbench: page,
  }) => {
    await checkSharedIndexDraft(page, comparison);
  });
}

async function checkSharedIndexDraft(page: Page, comparison: "three-way" | "two-way" | "local") {
  const root = "/dev/acme-api";
  const path = `${root}/build.gradle.kts`;
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path }) => {
      let text = "val staged = 1\n";
      let version = "one";
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_file_at = (args) => (args.rev === ":0" ? text : "val head = 0\n");
      h.vcs_staged_text = () => ({ text, version });
      h.vcs_save_staged_text = (args) => {
        if (args.path !== path || args.version !== version)
          throw { kind: "outOfSync", message: "The staged version changed on disk" };
        text = String(args.text);
        version = "saved";
        return version;
      };
      h.test_restage = () => {
        text = "val external = 4\n";
        version = "external";
      };
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { project: Record<string, unknown>; settings: Record<string, unknown> }) => ({
        project: { ...s.project, isGit: true },
        settings: { ...s.settings, files: { autoSave: false }, vcs: { git: { stagingArea: true } } },
      }));
      const store = "/src/features/vcs/store.ts";
      await (await import(/* @vite-ignore */ store)).refreshNow();
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("vcs.showStagedVersion", path);
    },
    { root, path },
  );
  const staged = page.locator('.cm-content[aria-label="Staged version editor"]');
  await expect(staged).toContainText("val staged = 1");
  const compare = () =>
    page.evaluate(
      async ({ path, comparison }) => {
        const input = "/src/features/vcs/diffInput.ts";
        const dialog = "/src/features/vcs/diffDialog.tsx";
        const { stagingGutterDiffData, workingDiffData } = await import(/* @vite-ignore */ input);
        const data =
          comparison === "three-way"
            ? stagingGutterDiffData(path)
            : { ...workingDiffData(path, 0, comparison === "local" ? "unstaged" : "staged"), mode: "split" };
        (await import(/* @vite-ignore */ dialog)).openDiffDialog(data);
      },
      { path, comparison },
    );
  await compare();
  const modal = page.getByRole("dialog", { name: /build\.gradle\.kts.*Staged/ });
  const index = modal.locator('.cm-content[aria-label="Staged (index)"]');
  await expect(index).toBeEditable();
  await index.fill("val draft = 2\n");
  await expect(staged).toContainText("val draft = 2");
  if (comparison === "two-way") {
    await modal.getByRole("button", { name: "Unified Viewer", exact: true }).click();
    await expect(modal.locator(".cm-content")).toHaveCount(1);
    await expect(index).toBeEditable();
    await expect(index).toContainText("val draft = 2");
  }
  await index.press("Meta+z");
  await expect(staged).toContainText("val staged = 1");
  await index.press("Meta+Shift+z");
  await expect(staged).toContainText("val draft = 2");
  await expect.poll(() => ipcCalls(page, "vcs_save_staged_text")).toEqual([]);
  const close = modal.getByRole("button", { name: "Close", exact: true }).last();
  await close.click();
  await expect(modal).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([{ path, text: "val draft = 2\n", version: "one" }]);

  await compare();
  await expect(index).toBeEditable();
  await index.fill("val unsaved = 3\n");
  await page.evaluate(() => window.__ipc.handlers.test_restage?.({}));
  await close.click();
  const error = modal.getByRole("alert").filter({ hasText: "The staged version changed on disk" });
  await expect(error).toBeVisible();
  await expect(index).toContainText("val unsaved = 3");
  await expect(staged).toContainText("val unsaved = 3");
  await error.getByRole("button", { name: "Reload Staged Version" }).click();
  await page.getByRole("dialog", { name: "Reload Staged Version" }).getByRole("button", { name: "Reload" }).click();
  await expect(index).toContainText("val external = 4");
  await expect(staged).toContainText("val external = 4");
  await close.click();
  await expect(modal).toBeHidden();
  await expect.poll(() => ipcCalls(page, "vcs_save_staged_text")).toHaveLength(2);
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);
}

test("applies individual changes in staging comparisons and rejects a stale index", async ({ workbench: page }) => {
  const path = "/dev/acme-api/build.gradle.kts";
  const body = (a: string, b: string, c: string) =>
    `val alpha = "${a}"\nval gap1 = true\nval beta = "${b}"\nval gap2 = true\nval gamma = "${c}"\n`;
  const head = body("HEAD", "HEAD", "HEAD");
  const index = body("index", "HEAD", "index");
  const external = body("external", "HEAD", "index");
  const local = body("index", "draft", "local");
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, head, index, external }) => {
      let text = index;
      let version = 1;
      const h = window.__ipc.handlers;
      const root = "/dev/acme-api";
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_file_at = (args) => (args.rev === ":0" ? text.replaceAll("\n", "\r\n") : head);
      h.vcs_staged_text = () => ({ text, version: String(version) });
      h.fs_probe = () => ({ size: head.length, binary: false, tooLarge: false });
      h.vcs_save_staged_text = (args) => {
        if (args.path !== path || args.version !== String(version)) {
          throw { kind: "outOfSync", message: "The staged version changed on disk" };
        }
        text = String(args.text);
        return String(++version);
      };
      h.test_restage = () => {
        text = external;
        version++;
      };
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { project: Record<string, unknown>; settings: Record<string, unknown> }) => ({
        project: { ...s.project, isGit: true },
        settings: {
          ...s.settings,
          files: { autoSave: false },
          vcs: { git: { stagingArea: true }, commit: { nonModal: true } },
        },
      }));
      const store = "/src/features/vcs/store.ts";
      const { refreshNow } = await import(/* @vite-ignore */ store);
      await refreshNow();
    },
    { path, head, index, external },
  );
  await page.locator(".cm-content:visible").evaluate((el, local) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: local } });
  }, local);
  const compare = (side: "staged" | "unstaged") =>
    page.evaluate(
      async ({ path, side }) => {
        const input = "/src/features/vcs/diffInput.ts";
        const { openDiff, workingDiffData } = await import(/* @vite-ignore */ input);
        await openDiff({ ...workingDiffData(path, 0, side), mode: "split" });
      },
      { path, side },
    );
  await compare("staged");
  const unstage = page.locator(".cm-gutter:visible").getByRole("button", { name: "Unstage Change", exact: true });
  await expect(unstage).toHaveCount(2);
  await expect(page.getByText("CRLF", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__ipc.handlers.test_restage?.({}));
  await unstage.first().click();
  await expect(page.getByText("The staged version changed on disk", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".cm-content:visible").filter({ hasText: 'val alpha = "external"' })).toHaveCount(1);
  await unstage.first().click();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([
      { path, text: body("HEAD", "HEAD", "index"), version: "1" },
      { path, text: body("HEAD", "HEAD", "index"), version: "2" },
    ]);

  await compare("unstaged");
  await page.getByRole("button", { name: "Unified Viewer", exact: true }).click();
  const stage = page.locator(".cm-gutter:visible").getByRole("button", { name: "Stage Change (git add hunk)" });
  await expect(stage).toHaveCount(3);
  await stage.nth(1).click();
  await expect(stage).toHaveCount(2);
  await expect.poll(() => ipcCalls(page, "vcs_save_staged_text")).toHaveLength(3);
  expect((await ipcCalls(page, "vcs_save_staged_text"))[2]).toEqual({
    path,
    text: body("HEAD", "draft", "index"),
    version: "3",
  });
  const reverts = page.locator(".cm-editor:visible").getByTitle("Revert this change", { exact: true });
  await expect(reverts).toHaveCount(2);
  await reverts.nth(1).click();
  await expect(stage).toHaveCount(1);
  const working = page.getByRole("tab", { name: "build.gradle.kts", exact: true });
  await working.click();
  const editor = page.locator(".cm-editor:visible .cm-content");
  await expect(editor).toContainText('val gamma = "index"');
  await expect(editor).toContainText('val alpha = "index"');
  await expect(editor).toContainText('val beta = "draft"');
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);
  await expect.poll(() => ipcCalls(page, "vcs_stage_hunks")).toEqual([]);
});

test("edits and stages from the index in unified diffs of read-only files", async ({ workbench: page }) => {
  const root = "/dev/acme-api";
  const path = `${root}/build.gradle.kts`;
  const body = (a: string, b: string) => `val alpha = "${a}"\nval gap = true\nval beta = "${b}"\n`;
  const staged = body("index", "index");
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.locator(".cm-content:visible").evaluate(
    (el, working) => {
      const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: working } });
    },
    body("local", "local"),
  );
  await page.evaluate(
    async ({ path, root, staged }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_file_at = () => staged;
      h.vcs_staged_text = () => ({ text: staged, version: "original" });
      h.vcs_save_staged_text = () => "saved";
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { project: Record<string, unknown>; settings: Record<string, unknown> }) => ({
        project: { ...s.project, isGit: true },
        settings: { ...s.settings, files: { autoSave: false }, vcs: { git: { stagingArea: true } } },
      }));
      const controller = "/src/editor/core/controller.ts";
      const { editorController } = await import(/* @vite-ignore */ controller);
      const model = editorController().manager.get(path);
      if (!model) throw new Error("Missing working document");
      h.test_set_readonly = ({ readOnly }) => model.setMeta({ readOnly });
      model.setMeta({ readOnly: true });
      const store = "/src/features/vcs/store.ts";
      await (await import(/* @vite-ignore */ store)).refreshNow();
      const input = "/src/features/vcs/diffInput.ts";
      const dialog = "/src/features/vcs/diffDialog.tsx";
      const { workingDiffData } = await import(/* @vite-ignore */ input);
      (await import(/* @vite-ignore */ dialog)).openDiffDialog({
        ...workingDiffData(path, 2, "unstaged"),
        mode: "unified",
      });
    },
    { path, root, staged },
  );
  const modal = page.getByRole("dialog", { name: /build\.gradle\.kts.*Staged/ });
  const index = modal.locator('.cm-content[aria-label="Staged (index)"]');
  await expect(index).toBeEditable();
  await expect(index).toHaveText(/val alpha = "index"\s+val alpha = "local"/, { useInnerText: true });
  const setReadOnly = (readOnly: boolean) =>
    page.evaluate((readOnly) => window.__ipc.handlers.test_set_readonly?.({ readOnly }), readOnly);
  await setReadOnly(false);
  await expect(modal.locator(".cm-content")).toBeEditable();
  await expect(index).toHaveCount(0);
  await setReadOnly(true);
  await expect(index).toBeEditable();
  await expect(modal.getByTitle("Revert this change", { exact: true })).toHaveCount(0);
  await index.evaluate((el) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    const line = view.state.doc.line(1);
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: 'val alpha = "draft"' },
      userEvent: "input.type",
    });
  });
  await expect(index).toContainText('val alpha = "draft"');
  const stage = modal.locator(".cm-gutter").getByRole("button", { name: "Stage Change (git add hunk)" });
  await expect(stage).toHaveCount(2);
  await stage.last().click();
  await expect(stage).toHaveCount(1);
  await expect.poll(() => ipcCalls(page, "vcs_save_staged_text")).toEqual([]);
  await modal.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(modal).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([{ path, text: body("draft", "local"), version: "original" }]);
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);
});

test("edits and reverts the local pane of a three-version diff without saving the file", async ({
  workbench: page,
}) => {
  const root = "/dev/acme-api";
  const path = `${root}/build.gradle.kts`;
  const body = (a: string, b: string, c: string) =>
    `val alpha = "${a}"\nval gap1 = true\nval beta = "${b}"\nval gap2 = true\nval gamma = "${c}"\n`;
  const head = body("HEAD", "HEAD", "HEAD");
  const index = body("index", "HEAD", "index");
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path, head, index }) => {
      const h = window.__ipc.handlers;
      let text = index;
      let version = 1;
      let saves = 0;
      h.test_saves = () => saves;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_file_at = (args) => (args.rev === ":0" ? text : head);
      h.vcs_staged_text = () => ({ text, version: String(version) });
      h.vcs_save_staged_text = (args) => {
        if (args.path !== path || args.version !== String(version)) throw new Error("stale index");
        text = String(args.text);
        return String(++version);
      };
      h.fs_probe = () => ({ size: head.length, binary: false, tooLarge: false });
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { project: Record<string, unknown>; settings: Record<string, unknown> }) => ({
        project: { ...s.project, isGit: true },
        settings: {
          ...s.settings,
          files: { autoSave: false },
          vcs: { git: { stagingArea: true }, commit: { nonModal: true } },
        },
      }));
      const editor = "/src/editor/api.ts";
      (await import(/* @vite-ignore */ editor)).onEditorEvent((event: { type: string; path: string }) => {
        if (event.type === "docSaved" && event.path === path) saves++;
      });
      const input = "/src/features/vcs/diffInput.ts";
      const { openDiff, stagingGutterDiffData } = await import(/* @vite-ignore */ input);
      await openDiff(stagingGutterDiffData(path, 0));
    },
    { root, path, head, index },
  );

  const local = page.locator('.cm-content[aria-label="Local Version"]:visible');
  await expect(local).toBeEditable();
  await local.fill(body("index", "draft", "temporary"));
  const revert = page.getByRole("button", { name: "Revert Change", exact: true });
  await expect(revert).toHaveCount(2);
  await revert.nth(1).click();
  await expect(local).toContainText('val gamma = "index"');
  await expect(local).toContainText('val beta = "draft"');
  await expect(revert).toHaveCount(1);
  await local.press("Meta+z");
  await expect(local).toContainText('val gamma = "temporary"');
  await local.press("Meta+Shift+z");
  await expect(local).toContainText('val gamma = "index"');
  const stage = page.getByRole("button", { name: "Stage Change (git add hunk)", exact: true });
  await expect(stage).toHaveCount(1);
  await stage.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([{ path, text: body("index", "draft", "index"), version: "1" }]);
  expect(await page.evaluate(() => window.__ipc.handlers.test_saves?.({}))).toBe(0);

  await page.getByRole("button", { name: "Jump to Source", exact: true }).click();
  const source = page.locator(".cm-content:visible");
  await expect(source).toContainText('val beta = "draft"');
  await expect(source).toContainText('val gamma = "index"');
  await source.press("Meta+s");
  await expect.poll(() => page.evaluate(() => window.__ipc.handlers.test_saves?.({}))).toBe(1);
});

test("exports the selected side of the index from the staging tree", async ({ workbench: page }) => {
  const root = "/dev/acme-api";
  const path = `${root}/build.gradle.kts`;
  const patch = "diff --git a/build.gradle.kts b/build.gradle.kts\n";
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path, patch }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" }];
      h.vcs_create_patch = () => patch;
      h.clipboard_write_text = () => null;
      h.vcs_write_patch = () => null;
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: {
          ...s.settings,
          vcs: { git: { stagingArea: true }, commit: { nonModal: true }, confirmation: { onPatchCreated: "no" } },
        },
      }));
      const store = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root });
      await refreshNow();
    },
    { root, path, patch },
  );

  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("tree", { name: "Changes", exact: true });
  const rows = changes.getByText("build.gradle.kts", { exact: true });
  await expect(rows).toHaveCount(2);
  await rows.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create Patch…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Patch", exact: true });
  await expect(dialog).toContainText("build.gradle.kts");
  await expect(dialog.getByRole("textbox", { name: "Base directory" })).toHaveValue(root);
  await dialog.getByRole("textbox", { name: "Base directory" }).fill("/dev");
  await dialog.getByRole("button", { name: "Patch encoding" }).click();
  await page.getByRole("option", { name: "UTF-16LE" }).click();
  const destination = await dialog.getByRole("textbox", { name: "Patch file" }).inputValue();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_write_patch"))
    .toEqual([{ path: destination, patch, encoding: "utf-16le" }]);

  await rows.last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Patch to Clipboard", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toEqual([{ text: patch }]);

  await rows.first().click();
  await rows.last().click({ modifiers: ["Meta"] });
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("vcs.copyPatch");
  });
  await expect
    .poll(() => ipcCalls(page, "vcs_create_patch"))
    .toEqual(
      ["staged", "unstaged", "both"].map((side) => ({
        repo: null,
        base: side === "staged" ? "/dev" : null,
        source: { from: "staging", entries: [{ path, side, renamedFrom: null }], reverse: false },
      })),
    );
});

test("rolls back selected unstaged rows and can stage a path without its contents", async ({ workbench: page }) => {
  const root = "/dev/acme-api";
  const tracked = `${root}/build.gradle.kts`;
  const untracked = `${root}/fresh.txt`;
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, tracked, untracked }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [
        { path: tracked, relPath: "build.gradle.kts", staged: "modified", unstaged: "modified" },
        { path: untracked, relPath: "fresh.txt", staged: null, unstaged: "untracked" },
      ];
      h.vcs_restore_unstaged = () => null;
      h.vcs_stage_without_content = () => null;
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: { ...s.settings, vcs: { git: { stagingArea: true }, commit: { nonModal: true } } },
      }));
      const store = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, tracked, untracked },
  );

  await page.keyboard.press("Meta+k");
  const changes = page.getByRole("tree", { name: "Changes", exact: true });
  const trackedRows = changes.getByText("build.gradle.kts", { exact: true });
  await expect(trackedRows).toHaveCount(2);
  await trackedRows.first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unstage", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Rollback/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await trackedRows.last().click();
  await page.keyboard.press("Meta+Alt+z");
  const dialog = page.getByRole("dialog", { name: "Rollback Unstaged Changes" });
  await expect(dialog).toContainText("build.gradle.kts");
  await dialog.getByRole("button", { name: "Rollback", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_restore_unstaged")).toEqual([{ paths: [tracked] }]);
  await expect.poll(() => ipcCalls(page, "vcs_unstage")).toEqual([]);
  await expect.poll(() => ipcCalls(page, "vcs_discard")).toEqual([]);

  await changes.getByRole("treeitem", { name: /^Unversioned Files/ }).click();
  await page.keyboard.press("ArrowRight");
  await changes.getByText("fresh.txt", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stage Without Content", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_stage_without_content")).toEqual([{ paths: [untracked] }]);
  await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual([]);
});

test("staging shortcuts allow requiring index changes and staging tracked files in bulk", async ({
  workbench: page,
}) => {
  const root = "/dev/acme-api";
  const tracked = root + "/build.gradle.kts";
  const untracked = root + "/notes.txt";
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, tracked, untracked }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111", operation: null }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      const stage = new Set<string>();
      h.vcs_status = () =>
        [tracked, untracked].map((path) => ({
          path,
          relPath: path.slice(root.length + 1),
          renamedFrom: null,
          staged: stage.has(path) ? (path === tracked ? "modified" : "added") : null,
          unstaged: stage.has(path) ? null : path === tracked ? "modified" : "untracked",
        }));
      h.vcs_stage = ({ paths }) => {
        for (const path of paths as string[]) stage.add(path);
        return null;
      };
      const settings = {
        vcs: { git: { stagingArea: true }, commit: { nonModal: true, commitAllWhenNothingStaged: true } },
      };
      h.settings_get = () => structuredClone(settings);
      h.settings_set = ({ key, value }) => {
        if (key === "vcs.commit.commitAllWhenNothingStaged") {
          settings.vcs.commit.commitAllWhenNothingStaged = JSON.parse(String(value));
        }
        return structuredClone(settings);
      };
      const projectModule = "/src/platform/project.ts";
      const { loadSettings } = await import(/* @vite-ignore */ projectModule);
      await loadSettings();
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, tracked, untracked },
  );

  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Update staging");
  await expect(panel.getByRole("button", { name: "Commit All", exact: true })).toBeEnabled();
  const options = panel.getByRole("button", { name: "Commit Options" });
  await options.click();
  const commitAll = page.getByRole("checkbox", { name: "Commit All when Nothing Is Staged" });
  await expect(commitAll).toBeChecked();
  await commitAll.click();
  await expect(commitAll).not.toBeChecked();
  const commit = panel.getByRole("button", { name: "Commit", exact: true });
  await expect(commit).toBeDisabled();
  expect(await ipcCalls(page, "settings_set")).toContainEqual({
    scope: "global",
    key: "vcs.commit.commitAllWhenNothingStaged",
    value: "false",
  });
  await page.keyboard.press("Escape");

  const stageTracked = panel.getByRole("button", { name: "Stage All Tracked", exact: true });
  await stageTracked.click();
  await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual([{ paths: [tracked] }]);
  await expect(commit).toBeEnabled();
  await expect(stageTracked).toBeDisabled();
  await expect(panel.getByRole("treeitem", { name: /Unversioned Files/ })).toBeVisible();

  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeActionOrThrow } = await import(/* @vite-ignore */ actionsModule);
    await executeActionOrThrow("vcs.stageAll");
  });
  await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual([{ paths: [tracked] }, { paths: [untracked] }]);
  await expect(panel.getByRole("treeitem", { name: /Unversioned Files/ })).toBeHidden();
});

test("shows ignored paths on demand without including them in the staging workflow", async ({ workbench: page }) => {
  await stubDesktop(page);
  const root = "/dev/acme-api";
  const tracked = root + "/build.gradle.kts";
  await page.evaluate(
    async ({ root, tracked }) => {
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111", operation: null }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [
        { path: tracked, relPath: "build.gradle.kts", staged: null, unstaged: "modified", renamedFrom: null },
      ];
      h.vcs_ignored_files = () =>
        ["cache/", "local.log"].map((relPath) => ({
          path: root + "/" + relPath.replace(/\/$/, ""),
          relPath,
          staged: null,
          unstaged: "ignored",
          renamedFrom: null,
        }));
      h.vcs_stage = () => null;
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: { ...s.settings, vcs: { git: { stagingArea: true }, commit: { nonModal: true } } },
      }));
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, tracked },
  );
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const tree = panel.getByRole("tree", { name: "Changes" });
  const ignored = tree.getByRole("treeitem", { name: /^Ignored Files/ });
  const view = panel.getByRole("button", { name: "View Options", exact: true });
  expect(await ipcCalls(page, "vcs_ignored_files")).toEqual([]);
  await expect(ignored).toBeHidden();
  await view.click();
  const showIgnored = page.getByRole("menuitemcheckbox", { name: "Show Ignored Files", exact: true });
  await showIgnored.click();
  await expect(ignored).toContainText("1 file · 1 folder");
  await ignored.click();
  await page.keyboard.press("ArrowRight");
  const log = tree.getByRole("treeitem", { name: "local.log", exact: true });
  await log.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Jump to Source" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Show Diff|^Stage|^Rollback/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.evaluate(async (root) => {
    window.__ipc.handlers.vcs_ignored_files = () => [
      { path: root + "/new.log", relPath: "new.log", staged: null, unstaged: "ignored", renamedFrom: null },
    ];
    const ipcModule = "/src/platform/ipc.ts";
    const { emitLocalIdeEvent } = await import(/* @vite-ignore */ ipcModule);
    emitLocalIdeEvent({ type: "excludedDirsChanged", dirs: [root] });
    const actionsModule = "/src/platform/actions.ts";
    const { executeActionOrThrow } = await import(/* @vite-ignore */ actionsModule);
    await executeActionOrThrow("vcs.stageAll");
  }, root);
  await expect(tree.getByRole("treeitem", { name: "new.log", exact: true })).toBeVisible();
  await expect(log).toBeHidden();
  await expect.poll(() => ipcCalls(page, "vcs_stage")).toEqual([{ paths: [tracked] }]);
  await view.click();
  await expect(showIgnored).toHaveAttribute("aria-checked", "true");
  await showIgnored.click();
  await expect(ignored).toBeHidden();
});

test("Commit and Push uses the checked staging repositories", async ({ workbench: page }) => {
  await stubDesktop(page);
  const root = "/dev/acme-api";
  const included = root + "/application";
  const excluded = root + "/library";
  await page.evaluate(
    async ({ root, included, excluded }) => {
      const h = window.__ipc.handlers;
      const branch = {
        head: "main",
        headCommit: "1111111",
        upstream: null,
        operation: null,
        ahead: 0,
        behind: 0,
      };
      const committed = new Set<string>();
      h.vcs_roots = () => [included, excluded].map((root) => ({ root, ...branch }));
      h.vcs_branch_info = () => branch;
      h.vcs_status = () =>
        [included, excluded].map((repo) => ({
          path: repo + "/changes.txt",
          relPath: "changes.txt",
          renamedFrom: null,
          staged: committed.has(repo) ? null : "modified",
          unstaged: "modified",
        }));
      h.vcs_config_get = () => "configured";
      h.vcs_commit = ({ repo }) => {
        committed.add(String(repo));
        return "2222222";
      };
      // The commit checks read the staged and HEAD versions.
      h.vcs_file_at = () => "changes\n";
      h.vcs_remotes = () => [];
      h.vcs_branches = () => [];
      h.vcs_log = () => [];
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: { ...s.settings, vcs: { git: { stagingArea: true, showPushDialog: true } } },
      }));
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: excluded, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, included, excluded },
  );
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const tree = panel.getByRole("tree", { name: "Changes", exact: true });
  const application = tree.getByRole("checkbox", { name: "Include application in commit" });
  const library = tree.getByRole("checkbox", { name: "Include library in commit" });
  await expect(application).toBeChecked();
  await expect(library).toBeChecked();
  await expect(tree.getByRole("checkbox")).toHaveCount(2);

  const libraryRow = tree.getByRole("treeitem").filter({
    has: page.getByRole("checkbox", { name: "Include library in commit" }),
  });
  await libraryRow.getByText("library", { exact: true }).click();
  await page.keyboard.press("Space");
  await expect(library).not.toBeChecked();
  await application.uncheck();
  await expect(panel.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  const push = panel.getByRole("button", { name: "Commit and Push…" });
  await expect(push).toBeDisabled();
  await application.check();

  const view = panel.getByRole("button", { name: "View Options", exact: true });
  const groupByRepo = page.getByRole("menuitemcheckbox", { name: "Repository", exact: true });
  await view.click();
  await groupByRepo.click();
  await expect(tree.getByRole("checkbox")).toHaveCount(0);
  await view.click();
  await groupByRepo.click();
  await expect(application).toBeChecked();
  await expect(library).not.toBeChecked();

  await panel.getByRole("textbox", { name: "Commit message", exact: true }).fill("Commit application only");
  await push.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_commit"))
    .toMatchObject([{ repo: included, message: "Commit application only", options: { stage: [], exclude: [] } }]);
  await expect(tree.getByRole("checkbox")).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: /Staged Changes 1 file/ })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Push Commits", exact: true });
  await expect(dialog.getByRole("checkbox", { name: "application", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "library", exact: true })).not.toBeChecked();
});

test("Amend previews the original commit independently of the staged changes", async ({ workbench: page }) => {
  await stubDesktop(page);
  const root = "/dev/acme-api";
  const file = `${root}/changes.txt`;
  await page.evaluate(
    async ({ root, file }) => {
      const h = window.__ipc.handlers;
      const branch = { head: "main", headCommit: "11111111", operation: null, upstream: null, ahead: 0, behind: 0 };
      h.vcs_roots = () => [{ root, ...branch }];
      h.vcs_branch_info = () => branch;
      h.vcs_status = () => [{ path: file, relPath: "changes.txt", staged: "modified", unstaged: null }];
      h.vcs_log = () => [
        {
          id: "11111111",
          shortId: "11111111",
          parents: ["00000000"],
          summary: "Original commit",
          message: "Original commit\n\nDescription",
        },
      ];
      h.vcs_commit_files = () => [{ kind: "renamed", path: "changes.txt", oldPath: "old-name.txt" }];
      h.vcs_file_at = ({ rev }) => (rev === "11111111" ? "committed contents\n" : "parent contents\n");
      h.vcs_diff_hunks = () => [];
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      useProject.setState((s: { settings: Record<string, unknown> }) => ({
        settings: { ...s.settings, vcs: { git: { stagingArea: true }, diffAsEditorTab: true } },
      }));
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root, file },
  );

  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  const amend = panel.getByRole("checkbox", { name: "Amend", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes", exact: true });
  await message.fill("Unsent draft");
  await amend.check();
  await expect(message).toHaveValue("Original commit\n\nDescription");
  await expect(changes.getByRole("treeitem", { name: /Original commit 1 file/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(changes.getByRole("treeitem", { name: /Staged Changes 1 file/ })).toBeVisible();
  const original = changes.getByRole("treeitem", { name: /changes.txt.*old-name.txt/ });
  await expect(original.getByRole("checkbox")).toHaveCount(0);
  await original.getByText("changes.txt", { exact: true }).click();
  await page.keyboard.press("Meta+d");
  await expect(page.getByRole("tab", { name: /00000000 ↔ 11111111/ })).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => ipcCalls(page, "vcs_file_at"))
    .toEqual(
      expect.arrayContaining([
        { path: `${root}/old-name.txt`, rev: "00000000" },
        { path: file, rev: "11111111" },
      ]),
    );
  await expect(page.locator(".cm-content:visible").getByText("committed contents")).toBeVisible();
  await expect(await ipcCalls(page, "vcs_commit")).toHaveLength(0);
  await amend.uncheck();
  await expect(changes.getByText("Original commit", { exact: true })).toHaveCount(0);
  await expect(message).toHaveValue("Unsent draft");
});
