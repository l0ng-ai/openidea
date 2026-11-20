import type { Page } from "@playwright/test";
import type { PatchFile } from "../src/bindings";
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
};

async function openPatch(page: Page, source: "file" | "clipboard", files: PatchFile[]) {
  await page.evaluate(
    async ({ source, repo, path, patch, files }) => {
      const handlers = window.__ipc.handlers;
      handlers.fs_read_text = () => patch;
      handlers.clipboard_text = () => patch;
      handlers.vcs_patch_preview = () => files;
      handlers.vcs_apply_patch = () => ({ applied: [files[0]?.path], conflicts: [] });
      const store = "/src/features/vcs/store.ts";
      const context = "/src/platform/context.ts";
      const actions = "/src/platform/actions.ts";
      (await import(/* @vite-ignore */ store)).useVcs.setState({ available: true, root: repo, repo, roots: [repo] });
      (await import(/* @vite-ignore */ context)).setContext("vcsAvailable", true);
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction(source === "file" ? "vcs.applyPatch" : "vcs.applyPatchFromClipboard", path);
    },
    { source, repo, path, patch, files },
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
  const list = dialog.getByRole("listbox", { name: "Patch files", exact: true });

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
  await expect.poll(() => ipcCalls(page, "vcs_apply_patch")).toEqual([{ repo, patch }]);
});
