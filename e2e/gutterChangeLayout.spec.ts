import type { EditorView } from "@codemirror/view";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("an inline change keeps its actions and original code readable at the editor zoom", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 445, height: 520 });
  await stubDesktop(page);
  const original = "const routingPolicy = 'use the legacy regional settlement cutoff before reconciliation';";
  const current = "const routingPolicy = 'use the current policy';";
  const content = Array.from({ length: 22 }, (_, i) => {
    if (i === 4) return current;
    if (i === 11) return "const settlementWindow = 12;";
    return `// context ${i + 1}`;
  }).join("\n");

  await page.evaluate(async (text) => {
    const service = "/src/workbench/contributions.ts";
    window.__ipc.handlers.fs_probe = () => ({ size: text.length, binary: false, tooLarge: false });
    window.__ipc.handlers.fs_read_text = () => text;
    await (await import(/* @vite-ignore */ service)).editorService().openFile("/dev/acme-api/settlement.ts");
  }, content);
  const editor = page.locator(".cm-editor");
  await expect(editor.locator(".cm-content")).toBeVisible();

  await editor.evaluate(
    async (el, { original, content }) => {
      const { view } = (el.querySelector(".cm-content") as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
      view.dom.style.setProperty("--openidea-editor-font-size", "18px");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0 } });
      window.__ipc.handlers.vcs_line_hunks = () => [
        { kind: "modified", start: 4, lines: 1, oldStart: 4, oldLines: 1, oldText: original + "\n" },
        { kind: "added", start: 11, lines: 1, oldStart: 11, oldLines: 0, oldText: "" },
        { kind: "deleted", start: 15, lines: 0, oldStart: 14, oldLines: 1, oldText: "// obsolete window\n" },
      ];
      const storeModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ storeModule);
      useVcs.setState({ available: true, version: useVcs.getState().version + 1 });
    },
    { original, content },
  );
  await editor.getByTitle("Modified lines (click to show)", { exact: true }).click();
  const modified = page.getByRole("dialog", { name: "Modified lines" });
  await expect(modified).toBeVisible();
  const originalText = modified.getByText(original, { exact: false });
  await expect(originalText).toHaveCSS("font-size", "18px");
  await expect(modified.getByText(current, { exact: false })).toHaveCount(0);
  await expect(editor.getByText(current, { exact: true })).toBeVisible();

  const preview = modified.getByRole("region", { name: "Original text" });
  await expect(preview.locator(".tok-keyword")).toHaveText("const");
  const toolbar = modified.getByRole("toolbar", { name: "Change actions" });
  expect(await preview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const previewBox = (await preview.boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  const currentBox = (await editor.getByText(current, { exact: true }).boundingBox())!;
  expect(previewBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height - 1);
  expect(
    toolbarBox.y >= currentBox.y + currentBox.height - 1 || previewBox.y + previewBox.height <= currentBox.y + 1,
  ).toBe(true);
  expect(previewBox.x).toBeGreaterThanOrEqual(0);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(445);
  await toolbar.getByRole("button", { name: "Next Change" }).click();
  const added = page.getByRole("dialog", { name: "Added lines" });
  await expect(added).toBeVisible();
  await expect(added.getByRole("region", { name: "Original text" })).toHaveCount(0);
  await expect(added.getByRole("button", { name: "Copy Original Text" })).toBeDisabled();

  await added.getByRole("button", { name: "Next Change" }).click();
  const deleted = page.getByRole("dialog", { name: "Deleted lines" });
  await expect(deleted.getByRole("region", { name: "Original text" })).toHaveText("// obsolete window");
  await deleted.getByRole("button", { name: "Rollback" }).click();
  await expect(deleted).toBeHidden();
  await expect(editor.getByText("// obsolete window", { exact: true })).toBeVisible();
});

test("stages and unstages a mixed gutter change and rolls back to the index", async ({ workbench: page }) => {
  const root = "/dev/acme-api";
  const path = `${root}/policy.ts`;
  const head = "const policy = 'HEAD';";
  const staged = "const policy = 'staged';";
  const working = "const policy = 'working';";
  const before = "// nearby before";
  const after = "// nearby after";
  const surround = (line: string) => `// outside before\n${before}\n${line}\n${after}\n// outside after\n`;
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, path, head, staged, committed, stagedFile }) => {
      const h = window.__ipc.handlers;
      let index = stagedFile;
      let version = 1;
      h.fs_probe = () => ({ size: staged.length, binary: false, tooLarge: false });
      h.fs_read_text = () => stagedFile;
      h.vcs_file_at = (args) => (args.rev === ":0" ? index : committed);
      h.vcs_roots = () => [{ root, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({ head: "main", headCommit: "1111111", operation: null });
      h.vcs_status = () => [{ path, relPath: "policy.ts", staged: "modified", unstaged: "modified" }];
      h.vcs_staged_text = () => ({ text: index, version: String(version) });
      h.vcs_save_staged_text = (args) => {
        if (args.version !== String(version))
          throw { kind: "outOfSync", message: "The staged version changed on disk" };
        index = String(args.text);
        return String(++version);
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
      const service = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
      h.vcs_staging_line_hunks = () => {
        const view = (document.querySelector(".cm-content") as (HTMLElement & { cmTile: { view: EditorView } }) | null)
          ?.cmTile.view;
        const indexLine = index.split("\n")[2]!;
        const localLine = view?.state.doc.toString().split("\n")[2] ?? staged;
        const hasStaged = indexLine !== head;
        const hasUnstaged = localLine !== indexLine;
        return {
          indexVersion: String(version),
          hunks:
            hasStaged || hasUnstaged
              ? [
                  {
                    kind: "modified",
                    start: 2,
                    lines: 1,
                    headStart: 2,
                    headLines: 1,
                    headText: head + "\n",
                    indexStart: 2,
                    indexLines: 1,
                    indexText: indexLine + "\n",
                    staged: hasStaged,
                    unstaged: hasUnstaged,
                  },
                ]
              : [],
        };
      };
      const store = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root });
      await refreshNow();
    },
    { root, path, head, staged, committed: surround(head), stagedFile: surround(staged) },
  );

  const editor = page.locator(".cm-editor");
  const content = editor.locator(".cm-content");
  await expect(content).toBeVisible();
  await content.evaluate((el, text) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, surround(staged));
  await expect(editor.locator(".cm-openidea-lane").getByTitle("Staged changes", { exact: true })).toBeVisible();
  await content.evaluate((el, text) => {
    const { view } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, surround(working));
  await editor.locator(".cm-openidea-lane").getByTitle("Staged and unstaged changes", { exact: true }).click();
  const mixed = page.getByRole("dialog", { name: "Staged and unstaged changes" });
  await expect(mixed.getByRole("region", { name: "HEAD" })).toHaveText(head);
  await expect(mixed.getByRole("region", { name: "Staged (index)" })).toHaveText(staged);
  await mixed.getByRole("button", { name: "Show Diff", exact: true }).click();
  const fragment = page.getByRole("dialog", { name: "Show Diff for Lines", exact: true });
  await expect(fragment).toBeVisible();
  const panes = fragment.locator(".cm-content");
  await expect(panes).toHaveCount(3);
  for (const [i, line] of [head, staged, working].entries()) {
    const pane = panes.nth(i);
    await expect(pane).toContainText(line);
    await expect(pane).toContainText(before);
    await expect(pane).toContainText(after);
    await expect(pane).not.toContainText("outside");
  }
  const local = fragment.locator('.cm-content[aria-label="Local Version"]');
  await expect(local).toBeEditable();
  await local.press("Meta+a");
  const selection = await local.evaluate((el) => {
    const { state } = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    return state.sliceDoc(state.selection.main.from, state.selection.main.to);
  });
  expect(selection).toBe([before, working, after].join("\n"));
  await fragment.getByRole("button", { name: "Revert Change", exact: true }).click();
  await expect(local).toContainText(staged);
  await local.press("Meta+z");
  await expect(local).toContainText(working);
  await fragment.getByRole("button", { name: "Stage Change (git add hunk)", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([{ path, text: surround(working), version: "1" }]);
  await fragment.getByRole("button", { name: "Close", exact: true }).last().click();
  await editor.locator(".cm-openidea-lane").getByTitle("Staged changes", { exact: true }).click();
  const stagedOnly = page.getByRole("dialog", { name: "Staged changes", exact: true });
  await expect(stagedOnly.getByRole("button", { name: "Rollback" })).toBeDisabled();
  await expect(editor.getByText(working, { exact: true })).toBeVisible();
  const unstage = stagedOnly.getByRole("button", { name: "Unstage Change", exact: true });
  await expect(unstage).toBeFocused();
  await unstage.click();
  const unstagedOnly = page.getByRole("dialog", { name: "Unstaged changes", exact: true });
  await expect(unstagedOnly.getByRole("region", { name: "Staged (index)" })).toHaveText(head);
  await unstagedOnly.getByRole("button", { name: "Rollback" }).click();
  await expect(editor.getByText(head, { exact: true })).toBeVisible();
  await expect
    .poll(() => ipcCalls(page, "vcs_save_staged_text"))
    .toEqual([
      { path, text: surround(working), version: "1" },
      { path, text: surround(head), version: "2" },
    ]);
  await expect.poll(() => ipcCalls(page, "doc_save")).toEqual([]);
});
