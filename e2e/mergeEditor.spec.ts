import { expect, test, type Locator, type Page } from "@playwright/test";

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");
const pad = (a: string[], b: string[]) => [...a, "p1", "p2", ...b];

// 0: a word-level conflict (price / tax), 1: a change of theirs only, 2: a real conflict.
const BASE = lines(...pad(["const total = price + tax;"], pad(["c"], pad(["same"], ["end"]))));
const OURS = lines(...pad(["const total = cost + tax;"], pad(["c"], pad(["mine"], ["end"]))));
const THEIRS = lines(...pad(["const total = price + fee;"], pad(["C"], pad(["yours"], ["end"]))));

/** Mounts the real merge editor on fixed versions, with the backend call replaced. */
async function mountMerge(page: Page) {
  await page.goto("/");
  await page.evaluate(
    async ([base, ours, theirs]) => {
      const reactPath = "/node_modules/.vite/deps/react.js";
      const domPath = "/node_modules/.vite/deps/react-dom_client.js";
      const react = await import(reactPath);
      const dom = await import(domPath);
      const { createElement } = react.default ?? react;
      const { createRoot } = dom.default ?? dom;
      const ipcPath = "/src/platform/ipc.ts";
      const editorPath = "/src/features/vcs/MergeEditor.tsx";
      const ipc = await import(ipcPath);
      (ipc.commands as unknown as Record<string, unknown>).vcsConflictVersions = async () => ({
        status: "ok",
        data: {
          base,
          ours,
          theirs,
          merged: null,
          sides: { operation: "merge", reversed: false, branch: "main", otherBranch: "feature", commit: null },
        },
      });
      const { MergeEditor } = await import(editorPath);
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;z-index:500;display:flex;background:white";
      host.id = "merge-host";
      document.body.append(host);
      createRoot(host).render(
        createElement(MergeEditor, { input: { key: "merge:demo.ts", data: { path: "/project/demo.ts" } } }),
      );
    },
    [BASE, OURS, THEIRS],
  );
  await expect(page.getByRole("region", { name: "Result" }).locator(".cm-content")).toBeVisible();
}

const result = (page: Page) => page.getByRole("region", { name: "Result" });
const text = async (pane: Locator) => (await pane.locator(".cm-content").innerText()).replace(/​/g, "");
const status = (page: Page) => page.locator("#merge-host [class*=status]").first();

test("the result starts as the base and every change waits for a decision", async ({ page }) => {
  await mountMerge(page);
  await expect(status(page)).toHaveText("3 changes left, 2 conflicts");
  expect((await text(result(page))).trimEnd()).toBe(BASE.trimEnd());
  // Accept and Ignore beside the changes of each side, a wand beside the conflict that needs no decision.
  await expect(page.getByRole("region", { name: "Your version" }).locator(".cm-merge-accept")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Their version" }).locator(".cm-merge-accept")).toHaveCount(3);
  await expect(result(page).locator(".cm-merge-wand")).toHaveCount(1);
});

test("resolves the simple conflicts and applies the other changes in one step", async ({ page }) => {
  await mountMerge(page);
  await page.getByRole("button", { name: "Resolve Simple Conflicts" }).click();
  await expect(status(page)).toHaveText("1 change left, 1 conflict");
  const out = await text(result(page));
  expect(out).toContain("const total = cost + fee;");
  expect(out).toContain("\nC\n");
  expect(out).toContain("\nsame\n");
  await page.getByRole("button", { name: "Revert Conflict Resolution" }).click();
  await expect(status(page)).toHaveText("3 changes left, 2 conflicts");
  expect((await text(result(page))).trimEnd()).toBe(BASE.trimEnd());
});

test("accepts both sides of a conflict in turn, and undo brings the buttons back", async ({ page }) => {
  await mountMerge(page);
  const mine = page.getByRole("region", { name: "Your version" }).locator(".cm-merge-accept");
  const yours = page.getByRole("region", { name: "Their version" }).locator(".cm-merge-accept");
  // The last conflict is the third change of the right pane and the second of the left.
  await mine.nth(1).click();
  await yours.nth(2).click();
  expect(await text(result(page))).toContain("\nmine\nyours\n");
  await expect(status(page)).toHaveText("2 changes left, 1 conflict");
  await expect(mine).toHaveCount(1);

  await result(page).locator(".cm-content").click();
  await page.keyboard.press("Meta+Z");
  await expect(yours).toHaveCount(3);
  expect(await text(result(page))).toContain("\nmine\n");
  expect(await text(result(page))).not.toContain("yours");
  await page.keyboard.press("Meta+Z");
  await expect(mine).toHaveCount(2);
  await expect(status(page)).toHaveText("3 changes left, 2 conflicts");
  await page.screenshot({ path: process.env.MERGE_SHOT, animations: "disabled" }).catch(() => undefined);
});

test("the toolbar applies the non-conflicting changes of one side", async ({ page }) => {
  await mountMerge(page);
  // Nothing in this file is a change of the left side only.
  await expect(page.getByRole("button", { name: "Apply Non-Conflicting Changes from the Left Side" })).toBeDisabled();
  await page.getByRole("button", { name: "Apply Non-Conflicting Changes from the Right Side" }).click();
  await expect(status(page)).toHaveText("2 changes left, 2 conflicts");
  expect(await text(result(page))).toContain("\nC\n");
  await expect(page.getByRole("button", { name: "Apply All Non-Conflicting Changes" })).toBeDisabled();
});

test("has the dialog's buttons: Accept Yours, Accept Theirs, Cancel and Apply", async ({ page }) => {
  await mountMerge(page);
  const footer = page.locator("#merge-host [class*=footer]");
  for (const name of ["Accept Yours", "Accept Theirs", "Cancel", "Apply"])
    await expect(footer.getByRole("button", { name, exact: true })).toBeVisible();
  // Unedited, Cancel just closes; once something was decided it asks first.
  await page.getByRole("button", { name: "Resolve Simple Conflicts" }).click();
  await footer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Exit without applying the changes");
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await footer.getByRole("button", { name: "Accept Theirs", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Discard the changes and take this version");
});

test("compares the versions in pairs", async ({ page }) => {
  await mountMerge(page);
  await page.getByRole("button", { name: "Compare Contents" }).click();
  for (const name of [
    "Yours and Result",
    "Result and Theirs",
    "Yours and Theirs",
    "Base and Yours",
    "Base and Result",
    "Base and Theirs",
  ])
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
});

test("keeps the option to apply the non-conflicting changes on opening in its settings", async ({ page }) => {
  await mountMerge(page);
  await page.locator("#merge-host").getByRole("button", { name: "Settings" }).click();
  const option = page.getByRole("menuitemcheckbox", { name: "Automatically Apply Non-Conflicting Changes" });
  await expect(option).toHaveAttribute("aria-checked", "false");
  await option.click();
  await expect(status(page)).toHaveText("2 changes left, 2 conflicts");
});

test("the context menus decide the changes under the caret", async ({ page }) => {
  await mountMerge(page);
  await result(page).locator(".cm-line", { hasText: "same" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Resolve Automatically" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Ignore", exact: true }).click();
  await expect(status(page)).toHaveText("2 changes left, 1 conflict");
  expect(await text(result(page))).toContain("\nsame\n");

  await page
    .getByRole("region", { name: "Their version" })
    .locator(".cm-line", { hasText: /^C$/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Resolve Using Theirs" }).click();
  await expect(status(page)).toHaveText("1 change left, 1 conflict");
  expect(await text(result(page))).toContain("\nC\n");
});

test("applies the non-conflicting changes on opening when asked to, and that is not a step to undo", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("openidea.merge.autoApplyNonConflicting", "true"));
  await mountMerge(page);
  await expect(status(page)).toHaveText("2 changes left, 2 conflicts");
  expect(await text(result(page))).toContain("\nC\n");
  await result(page).locator(".cm-content").click();
  await page.keyboard.press("Meta+Z");
  expect(await text(result(page))).toContain("\nC\n");
});
