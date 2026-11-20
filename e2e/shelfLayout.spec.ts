import { expect, stubDesktop, test } from "./fixtures";

test("Shelf keeps patch and file selection available in a narrow dock", async ({ workbench: page }) => {
  const name = "Reconcile payment and settlement totals before exporting ledger reports";
  const directory = "services/settlement/internal/payment-reconciliation/statement-generation";
  const filename = "invoiceSettlementRowAssembler.ts";
  const file = directory + "/" + filename;
  await page.setViewportSize({ width: 1440, height: 760 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ name, file }) => {
      const root = "/dev/acme-api";
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
      h.vcs_status = () => [];
      h.vcs_shelves = () => [
        {
          id: "settlement",
          name,
          timeMs: null,
          branch: "main",
          files: [file, "README.md"].map((path) => ({ path, kind: "modified", oldPath: null })),
        },
        {
          id: "docs",
          name: "Update release notes",
          timeMs: null,
          branch: "main",
          files: [{ path: "CHANGELOG.md", kind: "modified", oldPath: null }],
        },
      ];
      h.vcs_shelf_diff = () => [];
      const vcs = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcs);
      useVcs.setState({ root, repo: root, roots: [root], available: true });
      const project = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      const settings = useProject.getState().settings ?? {};
      useProject.setState({ settings: { ...settings, vcs: { ...settings.vcs, commit: { nonModal: true } } } });
      const context = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ context)).setContext("vcsAvailable", true);
      const dock = "/src/workbench/toolwindows/store.ts";
      (await import(/* @vite-ignore */ dock)).setToolWindowSize("left", 228);
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("vcs.showShelf");
    },
    { name, file },
  );

  const panel = page.locator("[data-shelf-panel]");
  const patches = panel.getByRole("tree", { name: "Shelved changes" });
  const patch = patches.getByRole("treeitem").filter({ hasText: name });
  await patch.click({ position: { x: 90, y: 12 } });
  if ((await patch.getAttribute("aria-expanded")) === "false") await page.keyboard.press("ArrowRight");
  const location = panel.getByText(directory, { exact: true });
  await expect.poll(() => location.evaluate((el) => el.clientWidth)).toBeGreaterThan(100);

  const divider = panel.getByRole("separator", { name: "Resize shelf panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const files = panel.getByRole("tree", { name: "Shelved files" });
  await expect(files.getByRole("treeitem")).toHaveCount(2);
  const pathBox = (await location.boundingBox())!;
  const filesBox = (await files.boundingBox())!;
  expect(pathBox.x).toBeLessThan(filesBox.x + filesBox.width - 50);
  const row = files.getByRole("treeitem").filter({ hasText: filename });
  await row.click({ position: { x: 90, y: 12 } });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "Unshelve…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Unshelve Changes" });
  await expect(
    dialog.getByRole("tree", { name: "Files to unshelve" }).getByText(filename, { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("README.md", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.evaluate(async () => {
    const dock = "/src/workbench/toolwindows/store.ts";
    (await import(/* @vite-ignore */ dock)).setToolWindowSize("left", 640);
  });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await patches.getByRole("treeitem").filter({ hasText: "Update release notes" }).click();
  await expect(files.getByRole("treeitem")).toHaveCount(1);
  await expect(files.getByText("CHANGELOG.md", { exact: true })).toBeVisible();
});
