import type { Page } from "@playwright/test";
import type { ChangelistState, PatchDirectoryMatches, PatchFile, PatchPathMapping } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const repo = "/dev/billing";
const path = "/tmp/release-2026/requests/adjust-invoices.patch";
const patch = "diff --git a/ledger/invoice.ts b/ledger/invoice.ts";
const invoice: PatchFile = {
  path: "ledger/invoice.ts",
  oldPath: null,
  kind: "modified",
  added: 3,
  removed: 1,
  binary: false,
  applies: true,
  missingBase: false,
};

async function openPatch(
  page: Page,
  source: "file" | "clipboard",
  files: PatchFile[],
  project?: string,
  discovery?: { directoryMatches: PatchDirectoryMatches[]; automaticMappings: PatchPathMapping[] },
) {
  await page.evaluate(
    async ({ source, repo, path, patch, files, project, discovery }) => {
      const handlers = window.__ipc.handlers;
      handlers.vcs_read_patch = () => patch;
      handlers.clipboard_text = () => patch;
      handlers.vcs_patch_preview = ({ target, mappings }) => {
        const manual = (mappings ?? []) as PatchPathMapping[];
        const automaticMappings =
          target === null
            ? (discovery?.automaticMappings ?? []).filter((entry) => !manual.some((m) => m.path === entry.path))
            : [];
        const effective = [...manual, ...automaticMappings];
        const mapping = (file: PatchFile) => effective.find((entry) => entry.path === file.path);
        return {
          files: files.map((file) => {
            const map = mapping(file);
            const resolved = !!(map?.file || map?.directory);
            const applies = target !== "repository" && (file.applies || resolved);
            return { ...file, applies, missingBase: file.missingBase && !resolved };
          }),
          base: target === "repository" ? null : (project ?? null),
          placements: effective.length
            ? files.map((file) => {
                const map = mapping(file);
                return {
                  path: file.path,
                  target:
                    map?.file ??
                    `${map?.directory ?? project ?? repo}/${file.path
                      .split("/")
                      .slice(map?.strip ?? 0)
                      .join("/")}`,
                  error: null,
                };
              })
            : null,
          directoryMatches: discovery?.directoryMatches ?? [],
          automaticMappings,
        };
      };
      handlers.vcs_apply_patch = () => ({ applied: [files[0]?.path], conflicts: [] });
      handlers.vcs_apply_project_patch = ({ paths }) => ({
        outcome: { applied: paths ?? files.map((file) => file.path), conflicts: [] },
        conflictedRepositories: [],
        failures: [],
      });
      handlers.vcs_apply_mapped_patch = handlers.vcs_apply_project_patch;
      const store = "/src/features/vcs/store.ts";
      const context = "/src/platform/context.ts";
      const actions = "/src/platform/actions.ts";
      const changelists = "/src/features/vcs/changelists.ts";
      (await import(/* @vite-ignore */ changelists)).useChangelists.setState({ loaded: true });
      (await import(/* @vite-ignore */ store)).useVcs.setState({
        available: true,
        root: project ?? repo,
        repo,
        roots: project ? [repo, `${project}/reports`] : [repo],
      });
      (await import(/* @vite-ignore */ context)).setContext("vcsAvailable", true);
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction(source === "file" ? "vcs.applyPatch" : "vcs.applyPatchFromClipboard", path);
    },
    { source, repo, path, patch, files, project, discovery },
  );
}

test("Apply Patch keeps the source, repository and file status aligned in a narrow dialog", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 485, height: 490 });
  await stubDesktop(page);
  await openPatch(page, "file", [
    invoice,
    { ...invoice, path: "apps/batch/ledger/international/settlement/settle-invoice.ts", applies: false },
    ...Array.from({ length: 20 }, (_, i) => ({ ...invoice, path: `ledger/settlement-${i + 1}.ts` })),
  ]);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const source = dialog.getByRole("textbox", { name: "Patch source", exact: true });
  const target = dialog.getByRole("textbox", { name: "Repository", exact: true });
  const list = dialog.getByRole("tree", { name: "Patch files", exact: true });

  await expect(source).toHaveValue(path);
  await expect(source).not.toBeEditable();
  await expect(target).toHaveValue(repo);
  await expect(dialog.getByRole("heading", { name: "Patch files", exact: true })).toBeVisible();
  await expect(dialog.getByText("22 files", { exact: true })).toBeVisible();
  expect((await source.boundingBox())!.y).toBeLessThan((await target.boundingBox())!.y);
  expect((await target.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);

  const stats = list.getByText("+3 −1", { exact: true });
  const first = (await stats.nth(0).boundingBox())!;
  const second = (await stats.nth(1).boundingBox())!;
  expect(Math.abs(first.x - second.x)).toBeLessThan(1);
  await expect(list.getByLabel("Does not apply cleanly", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("status")).toHaveText("1 file will be merged; conflicts open in the merge tool");
  await list.press("End");
  await expect(list.getByText("settlement-20.ts", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await dialog.locator("[data-dialog-body]").evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await ipcCalls(page, "vcs_apply_patch")).toEqual([]);
});

test("Apply Patch previews clipboard contents and applies them to the previewed repository", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await openPatch(page, "clipboard", []);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: Clipboard", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Patch source", exact: true })).toHaveValue("Clipboard");
  await expect(dialog.getByText("No changes", { exact: true })).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  await openPatch(page, "clipboard", [invoice]);
  await expect(dialog.getByText("1 file", { exact: true })).toBeVisible();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => ipcCalls(page, "vcs_apply_patch")).toEqual([{ repo, patch, paths: null }]);
});

test("Apply Patch applies only included files and updates the merge count", async ({ workbench: page }) => {
  await stubDesktop(page);
  const receipt = { ...invoice, path: "ledger/receipt.ts", applies: false };
  await openPatch(page, "file", [invoice, receipt]);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  const all = dialog.getByRole("checkbox", { name: "Include all files", exact: true });
  const receiptBox = dialog.getByRole("checkbox", { name: `Include ${receipt.path}`, exact: true });
  await expect(all).toBeChecked();
  await expect(dialog.getByRole("status")).toBeVisible();
  await all.uncheck();
  await expect(apply).toBeDisabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await all.check();
  await expect(receiptBox).toBeChecked();
  const tree = dialog.getByRole("tree", { name: "Patch files", exact: true });
  await tree.press("End");
  await tree.press("Space");
  await expect(receiptBox).not.toBeChecked();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByText("1 of 2 selected")).toBeVisible();
  await apply.click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => ipcCalls(page, "vcs_apply_patch")).toEqual([{ repo, patch, paths: [invoice.path] }]);
});

test("Apply Patch opens a read-only diff for the selected row and loads its neighbours on demand", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  const project = "/dev";
  const billing = { ...invoice, path: "billing/invoice.ts" };
  const reports = { ...invoice, path: "reports/invoice.ts", applies: false };
  const notes = { ...invoice, path: "reports/notes.ts", applies: false };
  await page.evaluate(
    ({ billing, reports, project }) => {
      window.__ipc.handlers.vcs_patch_file_diff = ({ path }) => ({
        path: `${project}/${path}`,
        oldPath: null,
        content:
          path === billing
            ? { kind: "text", before: "const total = 100;\n", after: "const total = 120;\n" }
            : path === reports
              ? {
                  kind: "conflict",
                  local: "const cap = 140;\n",
                  base: "const cap = 100;\n",
                  patched: "const cap = 120;\n",
                }
              : {
                  kind: "raw",
                  local: "const total = 90;\n",
                  patch: "@@ -1 +1 @@\n-const total = 100;\n+const total = 120;\n",
                  applies: false,
                },
      });
    },
    { billing: billing.path, reports: reports.path, project },
  );
  await openPatch(page, "file", [billing, reports, notes], project);
  const apply = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const includeBilling = apply.getByRole("checkbox", { name: `Include ${billing.path}`, exact: true });
  await includeBilling.uncheck();
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual([]);
  await apply.getByRole("button", { name: "Show Diff", exact: true }).click();
  const diff = (path: string) => page.getByRole("dialog", { name: `Patch Diff: ${path}`, exact: true });
  const clean = diff(billing.path);
  await expect(clean.locator(".cm-content").first()).toContainText("const total = 100;");
  await expect(clean.locator(".cm-content").last()).toContainText("const total = 120;");
  await expect(clean.locator(".cm-content").last()).not.toBeEditable();
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual([
    { repo, base: project, patch, path: billing.path, mappings: null },
  ]);

  await clean.getByRole("button", { name: "Compare Next File", exact: true }).click();
  const conflict = diff(reports.path);
  await expect(conflict.locator('.cm-content[aria-label="Local Version"]')).toContainText("const cap = 140;");
  await expect(conflict.locator('.cm-content[aria-label="Base"]')).toContainText("const cap = 100;");
  await expect(conflict.locator('.cm-content[aria-label="Patched Version"]')).toContainText("const cap = 120;");
  await conflict.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(includeBilling).not.toBeChecked();
  const tree = apply.getByRole("tree", { name: "Patch files", exact: true });
  await tree.press("End");
  await tree.press("Meta+d");
  const fallback = diff(notes.path);
  await expect(fallback.getByRole("status")).toHaveText("The patch does not match the local file.");
  await expect(fallback.getByText("+const total = 120;", { exact: false })).toBeVisible();
  await fallback.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(apply).toBeVisible();
  await expect(includeBilling).not.toBeChecked();
  expect(await ipcCalls(page, "vcs_apply_patch")).toEqual([]);
  expect(await ipcCalls(page, "vcs_apply_project_patch")).toEqual([]);
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual(
    [billing, reports, notes].map((file) => ({ repo, base: project, patch, path: file.path, mappings: null })),
  );
});

test("Apply Patch keeps project mappings through preview, target changes and partial selection", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  const project = "/dev";
  const billing = { ...invoice, path: "billing/invoice.ts" };
  const reports = { ...invoice, path: "reports/invoice.ts" };
  await openPatch(page, "file", [billing, reports], project);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const target = dialog.getByRole("button", { name: "Patch target", exact: true });
  await expect(target).toHaveText("Project paths");
  await expect(target).toHaveAttribute("title", project);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await target.click();
  await page.getByRole("option", { name: /^reports/ }).click();
  await expect(target).toHaveText("reports");
  await expect(dialog.getByRole("status")).toContainText("2 files will be merged");
  await target.click();
  await page.getByRole("option", { name: /^Project paths/ }).click();
  await expect(target).toHaveText("Project paths");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  const excluded = dialog.getByRole("checkbox", { name: `Include ${reports.path}`, exact: true });
  await excluded.uncheck();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "vcs_apply_project_patch"))
    .toEqual([{ base: project, patch, paths: [billing.path] }]);
  expect(await ipcCalls(page, "vcs_apply_patch")).toEqual([]);
  expect(await ipcCalls(page, "vcs_patch_preview")).toEqual([
    { repo, patch, target: null, mappings: null },
    { repo: "/dev/reports", patch, target: "repository", mappings: null },
    { repo, patch, target: "project", mappings: null },
  ]);
});

test("Apply Patch maps a selected file and strips path components for both Diff and Apply", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  const project = "/dev";
  const directory = "/dev/reports/incoming";
  const moved = {
    ...invoice,
    path: "legacy/deep/renamed.ts",
    oldPath: "legacy/deep/original.ts",
    kind: "renamed" as const,
  };
  await page.evaluate(
    ({ directory, path }) => {
      const handlers = window.__ipc.handlers;
      handlers["plugin:dialog|open"] = () => directory;
      handlers.vcs_patch_file_diff = () => ({
        path: `${directory}/${path}`,
        oldPath: `${directory}/original.ts`,
        content: { kind: "text", before: "const rate = 1;\n", after: "const rate = 2;\n" },
      });
    },
    { directory, path: "renamed.ts" },
  );
  await openPatch(page, "file", [invoice, moved], project);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const other = dialog.getByRole("checkbox", { name: `Include ${invoice.path}`, exact: true });
  const row = dialog.getByRole("treeitem").filter({ hasText: "renamed.ts" });
  const menu = dialog.getByRole("button", { name: "Change Directory Paths", exact: true });
  await other.uncheck();
  await row.click();
  await menu.click();
  await page.getByRole("menuitem", { name: "Map Directory…", exact: true }).click();
  const displayed = "reports/incoming";
  await expect(row.getByText(`${displayed}/legacy/deep`, { exact: true })).toBeVisible();

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove All Leading Directories", exact: true }).click();
  await expect(row.getByText(displayed, { exact: true })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Restore Leading Directory", exact: true }).click();
  await expect(row.getByText(`${displayed}/deep`, { exact: true })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Remove Leading Directory", exact: true }).click();
  await expect(row.getByText(displayed, { exact: true })).toBeVisible();
  await expect(other).not.toBeChecked();

  const mappings = [{ path: moved.path, directory, strip: 2, file: null }];
  await row.dblclick();
  const diff = page.getByRole("dialog", { name: /^Patch Diff: .*incoming\/renamed\.ts$/ });
  await expect(diff.locator(".cm-content").last()).toContainText("const rate = 2;");
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual([
    { repo, base: project, patch, path: moved.path, mappings },
  ]);
  await diff.getByRole("button", { name: "Close", exact: true }).last().click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_apply_mapped_patch"))
    .toEqual([{ repo, base: project, patch, paths: [moved.path], mappings }]);
  expect(await ipcCalls(page, "vcs_apply_project_patch")).toEqual([]);
  expect(await ipcCalls(page, "vcs_apply_patch")).toEqual([]);
});

test("Apply Patch lets a missing base use an existing file without renaming it", async ({ workbench: page }) => {
  await stubDesktop(page);
  const missing = {
    ...invoice,
    path: "legacy/renamed.ts",
    oldPath: "legacy/original.ts",
    kind: "renamed" as const,
    applies: false,
    missingBase: true,
  };
  const replacement = "/dev/billing/current/local name.ts";
  await page.evaluate((replacement) => {
    const handlers = window.__ipc.handlers;
    let choices = 0;
    handlers["plugin:dialog|open"] = () => (++choices < 3 ? null : replacement);
    handlers.vcs_patch_file_diff = () => ({
      path: replacement,
      oldPath: null,
      content: { kind: "text", before: "const rate = 1;\n", after: "const rate = 2;\n" },
    });
  }, replacement);
  await openPatch(page, "file", [missing, invoice]);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const include = dialog.getByRole("checkbox", { name: `Include ${missing.path}`, exact: true });
  await dialog.getByRole("checkbox", { name: `Include ${invoice.path}`, exact: true }).uncheck();
  const tree = dialog.getByRole("tree", { name: "Patch files", exact: true });
  await tree.press("Home");
  await expect(include).toBeDisabled();
  await expect(include).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Show Diff", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/will be merged/)).toHaveCount(0);

  await dialog.getByRole("button", { name: "Select missing base…", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "plugin:dialog|open")).toHaveLength(1);
  await expect(include).toBeDisabled();
  await tree.press("Home");
  await tree.press("Space");
  await expect.poll(() => ipcCalls(page, "plugin:dialog|open")).toHaveLength(2);
  await expect(include).toBeDisabled();
  await tree.getByRole("treeitem").filter({ hasText: "renamed.ts" }).dblclick();
  await expect(tree.getByText("local name.ts", { exact: true })).toBeVisible();
  await expect(include).toBeChecked();

  const mappings = [{ path: missing.path, directory: null, strip: 0, file: replacement }];
  const row = tree.getByRole("treeitem").filter({ hasText: "local name.ts" });
  await row.dblclick();
  const diff = page.getByRole("dialog", { name: /^Patch Diff: .*local name\.ts$/ });
  await expect(diff.locator(".cm-content").last()).toContainText("const rate = 2;");
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual([
    { repo, base: null, patch, path: missing.path, mappings },
  ]);
  await diff.getByRole("button", { name: "Close", exact: true }).last().click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_apply_mapped_patch"))
    .toEqual([{ repo, base: null, patch, paths: [missing.path], mappings }]);
});

test("Apply Patch detects a matching directory and leaves equally good matches for review", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  const missing = { ...invoice, applies: false, missingBase: true };
  const settings = { ...missing, path: "checkout/src/settings.ts" };
  const report = { ...missing, path: "checkout/src/report.ts" };
  const candidate = (directory: string, name: string, applies: boolean) => ({
    directory,
    source: `${directory}/src/${name}.ts`,
    strip: 1,
    applies,
  });
  const suggested = candidate("/dev/billing/current", "settings", true);
  const alpha = candidate("/dev/reports/alpha", "report", true);
  const beta = candidate("/dev/reports/beta", "report", true);
  const auto = { path: settings.path, directory: suggested.directory, strip: 1, file: null };
  const chosen = { path: report.path, directory: beta.directory, strip: 1, file: null };
  await page.evaluate((target) => {
    window.__ipc.handlers.vcs_patch_file_diff = () => ({
      path: target,
      oldPath: null,
      content: { kind: "text", before: "const total = 10;\n", after: "const total = 15;\n" },
    });
  }, beta.source);
  await openPatch(page, "file", [settings, report], "/dev", {
    automaticMappings: [auto],
    directoryMatches: [
      { path: settings.path, candidates: [suggested, candidate("/dev/reports/other", "settings", false)] },
      { path: report.path, candidates: [alpha, beta] },
    ],
  });
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const tree = dialog.getByRole("tree", { name: "Patch files", exact: true });
  const mapped = tree.getByRole("treeitem").filter({ hasText: "settings.ts" });
  await expect(mapped.getByText("billing/current/src", { exact: true })).toBeVisible();
  await expect(mapped.getByRole("checkbox")).toBeChecked();
  const review = tree.getByRole("treeitem").filter({ hasText: "report.ts" });
  await expect(review.getByRole("checkbox")).toBeDisabled();
  await review.getByRole("button", { name: "Choose matching directory…", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Choose Matching Directory", exact: true });
  await expect(menu.getByRole("menuitemcheckbox", { name: "reports/alpha/src/report.ts" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Choose Directory…", exact: true })).toBeVisible();
  await menu.getByRole("menuitemcheckbox", { name: "reports/beta/src/report.ts" }).click();
  await expect(review.getByText("reports/beta/src", { exact: true })).toBeVisible();
  await expect(review.getByRole("checkbox")).toBeChecked();
  await expect(mapped.getByRole("checkbox")).toBeChecked();
  await review.dblclick();
  const diff = page.getByRole("dialog", { name: /^Patch Diff: .*beta\/src\/report\.ts$/ });
  await expect(diff.locator(".cm-content").last()).toContainText("const total = 15;");
  const mappings = [chosen, auto];
  expect(await ipcCalls(page, "vcs_patch_file_diff")).toEqual([
    { repo, base: "/dev", patch, path: report.path, mappings },
  ]);
  await diff.getByRole("button", { name: "Close", exact: true }).last().click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_apply_mapped_patch"))
    .toEqual([{ repo, base: "/dev", patch, paths: null, mappings }]);
});

test("Apply Patch keeps a new file selected when its directory has several matches", async ({ workbench: page }) => {
  await stubDesktop(page);
  const welcome = { ...invoice, kind: "added" as const, path: "checkout/mail/templates/emails/welcome.txt" };
  const banner = { ...invoice, kind: "added" as const, path: "checkout/widgets/templates/banner.txt" };
  const mappedDirectory = "/dev/billing/modules";
  const alpha = "/dev/billing/alpha";
  const beta = "/dev/reports/beta";
  const candidate = (directory: string, path: string) => ({
    directory,
    source: `${directory}/${path.split("/").slice(1).join("/")}`,
    strip: 1,
    applies: true,
  });
  const auto = { path: welcome.path, directory: mappedDirectory, strip: 1, file: null };
  const chosen = { path: banner.path, directory: beta, strip: 1, file: null };
  await openPatch(page, "file", [welcome, banner], "/dev", {
    automaticMappings: [auto],
    directoryMatches: [
      { path: welcome.path, candidates: [candidate(mappedDirectory, welcome.path)] },
      { path: banner.path, candidates: [candidate(alpha, banner.path), candidate(beta, banner.path)] },
    ],
  });
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const tree = dialog.getByRole("tree", { name: "Patch files", exact: true });
  const added = tree.getByRole("treeitem").filter({ hasText: "welcome.txt" });
  await expect(added.getByText("billing/modules/mail/templates/emails", { exact: true })).toBeVisible();
  const review = tree.getByRole("treeitem").filter({ hasText: "banner.txt" });
  await expect(review.getByRole("checkbox")).toBeChecked();
  await expect(review.getByText("checkout/widgets/templates", { exact: true })).toBeVisible();
  await review.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Map Directory…", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "reports/beta/widgets/templates/banner.txt", exact: true }).click();
  await expect(review.getByText("reports/beta/widgets/templates", { exact: true })).toBeVisible();
  await expect(review.getByRole("checkbox")).toBeChecked();
  await expect(added.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_apply_mapped_patch"))
    .toEqual([{ repo, base: "/dev", patch, paths: null, mappings: [chosen, auto] }]);
});

test("Apply Patch assigns only successful and conflicted files to the chosen changelist", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  const saved = { ...invoice, path: "billing/invoice.ts" };
  const added = { ...invoice, kind: "added" as const, path: "legacy/new.ts" };
  const conflict = { ...invoice, path: "reports/conflict.ts", applies: false };
  const failed = { ...invoice, path: "archive/failed.ts" };
  const mapped = { path: added.path, directory: "/dev/reports", strip: 1, file: null };
  await openPatch(page, "file", [saved, added, conflict, failed], "/dev", {
    directoryMatches: [],
    automaticMappings: [mapped],
  });
  await page.evaluate(async () => {
    const lists = "/src/features/vcs/changelists.ts";
    const { initialChangelists, useChangelists } = await import(/* @vite-ignore */ lists);
    const state = initialChangelists();
    useChangelists.setState({
      state: { ...state, lists: [...state.lists, { id: "review", name: "Review", comment: "" }] },
    });
    const handlers = window.__ipc.handlers;
    handlers.vcs_changelists_save = () => null;
    const head = { head: "main", headCommit: "01122", operation: null, hasRemotes: false };
    handlers.vcs_roots = () => ["/dev/billing", "/dev/reports", "/dev/archive"].map((root) => ({ root, ...head }));
    handlers.vcs_branch_info = () => head;
    let intent = false;
    handlers.vcs_stage_without_content = () => {
      intent = true;
      return null;
    };
    handlers.vcs_status = () =>
      [
        ["billing/invoice.ts", "modified"],
        ["billing/unrelated.ts", "modified"],
        ["reports/new.ts", intent ? "added" : "untracked"],
        ["reports/conflict.ts", "conflicted"],
        ["archive/failed.ts", "modified"],
      ].map(([path, unstaged]) => ({ path: `/dev/${path}`, relPath: path, staged: null, unstaged }));
    handlers.vcs_apply_mapped_patch = () => ({
      outcome: { applied: ["/dev/billing/invoice.ts", "/dev/reports/new.ts"], conflicts: ["/dev/reports/conflict.ts"] },
      conflictedRepositories: ["/dev/reports"],
      failures: [{ root: "/dev/archive", error: { kind: "invalid", message: "File did not match", detail: null } }],
    });
    const actions = "/src/platform/actions.ts";
    const { registerActions } = await import(/* @vite-ignore */ actions);
    registerActions([{ id: "vcs.resolveConflicts", title: "Resolve Conflicts…", run: () => {} }]);
  });
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const target = dialog.getByRole("textbox", { name: "Target changelist", exact: true });
  await expect(target).toHaveValue("Changes");
  await dialog.getByRole("button", { name: "Choose changelist", exact: true }).click();
  await page.getByRole("option", { name: "Review", exact: true }).click();
  await expect(target).toHaveValue("Review");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => {
      const saved = (await ipcCalls(page, "vcs_changelists_save")).at(-1)?.changelists as ChangelistState | undefined;
      return saved?.files;
    })
    .toEqual({
      "billing/invoice.ts": "review",
      "billing/unrelated.ts": "default",
      "reports/new.ts": "review",
      "reports/conflict.ts": "review",
      "archive/failed.ts": "default",
    });
  expect(await ipcCalls(page, "vcs_stage_without_content")).toEqual([{ paths: ["/dev/reports/new.ts"] }]);
  expect(await ipcCalls(page, "vcs_stage")).toEqual([]);
});

test("Apply Patch creates a typed changelist when repository-relative changes are applied", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await openPatch(page, "file", [invoice]);
  await page.evaluate(
    ({ repo, path }) => {
      const h = window.__ipc.handlers;
      const head = { head: "main", headCommit: "001122", operation: null, hasRemotes: false };
      h.vcs_roots = () => [{ root: repo, ...head }];
      h.vcs_branch_info = () => head;
      h.vcs_changelists_save = () => null;
      h.vcs_status = () => [{ path: `${repo}/${path}`, relPath: path, staged: null, unstaged: "modified" }];
    },
    { repo, path: invoice.path },
  );
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  const target = dialog.getByRole("textbox", { name: "Target changelist", exact: true });
  await target.fill("Abandoned");
  await expect(dialog.getByText("New", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await ipcCalls(page, "vcs_changelists_save")).toEqual([]);
  await openPatch(page, "file", [invoice]);
  await target.fill("  ");
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeDisabled();
  await target.fill("Release review");
  await apply.click();
  await expect
    .poll(async () => {
      const saved = (await ipcCalls(page, "vcs_changelists_save")).at(-1)?.changelists as ChangelistState | undefined;
      const listId = saved?.files?.[invoice.path];
      return saved?.lists.find((list) => list.id === listId)?.name;
    })
    .toBe("Release review");
  expect(await ipcCalls(page, "vcs_stage_without_content")).toEqual([]);
});

test("Apply Patch uses the working tree directly in staging mode", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    useProject.setState((s: { settings: Record<string, unknown> }) => ({
      settings: { ...s.settings, vcs: { git: { stagingArea: true }, commit: { nonModal: true } } },
    }));
  });
  await openPatch(page, "file", [invoice]);
  const dialog = page.getByRole("dialog", { name: "Apply Patch: adjust-invoices.patch", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Target changelist", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "vcs_apply_patch")).toEqual([{ repo, patch, paths: null }]);
  expect(await ipcCalls(page, "vcs_changelists_save")).toEqual([]);
  expect(await ipcCalls(page, "vcs_stage_without_content")).toEqual([]);
});
