import type { EditorView } from "@codemirror/view";
import { expect, stubDesktop, test } from "./fixtures";

test("selection history keeps a full-width diff above a keyboard-resizable revision table", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1140, height: 740 });
  const filename = "QuarterlyCrossBorderSettlementReconciliationProjection.ts";
  const path = `/dev/acme-api/modules/${filename}`;
  const lastMessage = "Introduce the reconciliation projection for pending cross-border merchant settlements";
  await page.evaluate(async (path) => {
    const backend = "/src/editor/core/backend.ts";
    (await import(/* @vite-ignore */ backend))
      .docBackend()
      .files.set(path, "export const pending = 0;\nconst projection = uncommitted;\n");
    const service = "/src/workbench/contributions.ts";
    await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
  }, path);
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("uncommitted");
  await editor.evaluate((el) => {
    const view = (el as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
    const line = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: line.from, head: line.to } });
    view.focus();
  });
  await stubDesktop(page);
  await page.evaluate(
    async ({ path, lastMessage }) => {
      window.__ipc.handlers.cancel_request = () => null;
      window.__ipc.handlers.vcs_block_history = () => ({
        headLines: [1, 1],
        revisions: Array.from({ length: 22 }, (_, i) => ({
          id: (i + 16).toString(16).padStart(40, "0"),
          shortId: (i + 16).toString(16).padStart(7, "0"),
          author: "Alexandra Reconciliation Coordinator",
          email: "coordinator@example.test",
          timeMs: 1738329600000 - i * 86400000,
          summary: i === 21 ? lastMessage : `Update reconciliation estimate ${22 - i}`,
          path,
          before: `const projection = estimate${21 - i};\n`,
          after: `const projection = estimate${22 - i};\n`,
          beforeLine: 1,
          afterLine: 1,
        })),
      });
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("vcs.showHistoryForSelection");
    },
    { path, lastMessage },
  );

  const diff = page.locator(".cm-mergeView");
  await expect(diff).toContainText("uncommitted");
  const revisions = page.getByRole("grid", { name: "Revisions" });
  const history = revisions.or(page.getByRole("listbox", { name: "Revisions" }));
  await expect(history).toBeVisible();
  const preview = (await diff.boundingBox())!;
  const list = (await history.boundingBox())!;
  expect(list.y).toBeGreaterThanOrEqual(preview.y + preview.height - 1);
  expect(preview.width).toBeGreaterThanOrEqual(list.width - 2);

  await expect(revisions.getByRole("columnheader")).toHaveText(["Revision", "Date", "Author", "Message"]);
  const divider = page.getByRole("separator", { name: "Revisions", exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const initial = (await divider.boundingBox())!.y;
  await divider.press("ArrowUp");
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeLessThan(initial);
  await expect(revisions.getByRole("row", { selected: true })).toContainText("Local Changes");

  await page.setViewportSize({ width: 490, height: 620 });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(page.getByTitle(`${filename}:2-2`, { exact: true })).toBeVisible();
  const body = revisions.getByRole("rowgroup");
  await body.press("End");
  const last = revisions.getByRole("row", { selected: true });
  await expect(last.getByRole("gridcell", { name: lastMessage, exact: true })).toHaveAttribute("title", lastMessage);
  await expect
    .poll(async () => {
      const listBounds = (await body.boundingBox())!;
      const rowBounds = (await last.boundingBox())!;
      return Math.max(listBounds.y - rowBounds.y, rowBounds.y + rowBounds.height - listBounds.y - listBounds.height);
    })
    .toBeLessThanOrEqual(1);
  const headers = revisions.getByRole("columnheader");
  const cells = last.getByRole("gridcell");
  for (let i = 0; i < 4; i++) {
    expect(
      Math.abs((await headers.nth(i).boundingBox())!.x - (await cells.nth(i).boundingBox())!.x),
    ).toBeLessThanOrEqual(1);
  }
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(diff).toContainText("estimate1");
});
