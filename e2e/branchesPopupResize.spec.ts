/**
 * Git Branches resizes by its edges and corner, as in IDEA, and reopens at that size.
 * Git is stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const NESTED_REF = "teams/payments/reporting/month-end/exports/regions/europe/accounting/invoice-export";
const TRACKING_REF = "origin/releases/payments/month-end/reconciliation/invoice-export";
const BRANCH_FIXTURE = { root: ROOT, ref: NESTED_REF, upstream: TRACKING_REF };

async function openBranches(page: Page) {
  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.branches");
  });
  const popup = page.getByRole("dialog", { name: "Git Branches" });
  await expect(popup.getByRole("listbox", { name: "Branches" })).toBeVisible();
  // Measure after the open animation: it slides the popup by a couple of pixels.
  await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return popup;
}

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async ({ root, ref, upstream }) => {
    const h = window.__ipc.handlers;
    const branch = (name: string, current = false) => ({
      name,
      current,
      remote: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommitMs: null,
      commit: "1111111",
    });
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
    h.vcs_tags = () => [];
    h.vcs_branches = () => [
      branch("main", true),
      { ...branch(ref), upstream, ahead: 2, behind: 3 },
      ...Array.from({ length: 40 }, (_, i) => branch(`task-${i}-a-long-branch-name-that-gets-cut-off`)),
    ];
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow, loadBranches } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
    await loadBranches();
  }, BRANCH_FIXTURE);
});

test("narrow Git Branches keeps a deeply nested branch and its controls readable", async ({ workbench: page }) => {
  await page.evaluate(() => {
    localStorage.setItem("openidea.vcs.branchesPopup.size", JSON.stringify({ w: 280, h: 420 }));
  });
  const popup = await openBranches(page);
  const search = popup.getByRole("textbox", { name: "Search branches and actions" });
  await search.fill("invoice-export");
  const row = popup.getByRole("option", { name: /invoice-export/ });
  await expect(row).toBeVisible();
  const name = row.locator("[class*=branchName]");
  const tracking = row.getByText(TRACKING_REF, { exact: true });
  const chevron = row.locator("svg").last();
  const folder = popup.getByRole("option", { name: "accounting", exact: true });
  const rowBox = (await row.boundingBox())!;
  const nameBox = (await name.boundingBox())!;
  const trackingBox = (await tracking.boundingBox())!;
  const chevronBox = (await chevron.boundingBox())!;
  const indent = (option: typeof row) =>
    option.locator("[data-row-key]").evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineStart));
  expect(await indent(row)).toBeGreaterThan(await indent(folder));
  expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(nameBox.width).toBeGreaterThan(42);
  expect(trackingBox.width).toBeGreaterThan(12);
  expect(trackingBox.width).toBeLessThan(rowBox.width * 0.4);
  await expect(name).toHaveCSS("font-size", "13px");
  await expect(tracking).toHaveCSS("font-size", "13px");
  await expect(row.getByRole("img", { name: "3 incoming commits" })).toBeVisible();
  await expect(row.getByRole("img", { name: "2 outgoing commits" })).toBeVisible();
  await expect(row.locator("[data-row-key]")).toHaveAttribute("title", NESTED_REF);
  await expect(tracking).toHaveAttribute("title", TRACKING_REF);
  await chevron.click();
  await expect(page.getByRole("menu", { name: `Branch ${NESTED_REF}` })).toBeVisible();
});

test("Git Branches resizes by its corner and right edge and reopens at that size", async ({ workbench: page }) => {
  let popup = await openBranches(page);
  const list = popup.getByRole("listbox", { name: "Branches" });
  const before = (await popup.boundingBox())!;
  const listBefore = (await list.boundingBox())!;

  // The corner: both dimensions; the list takes the extra height.
  const corner = (await popup.getByRole("separator", { name: "Resize" }).boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 120, corner.y + corner.height / 2 + 150, { steps: 5 });
  await page.mouse.up();
  const grown = (await popup.boundingBox())!;
  expect(grown.width).toBeCloseTo(before.width + 120, 0);
  expect(grown.height).toBeCloseTo(before.height + 150, 0);
  expect(grown.x).toBeCloseTo(before.x, 0);
  expect(grown.y).toBeCloseTo(before.y, 0);
  expect((await list.boundingBox())!.height).toBeCloseTo(listBefore.height + 150, 0);

  // The right edge: the width only.
  await page.mouse.move(grown.x + grown.width - 2, grown.y + grown.height / 2);
  await page.mouse.down();
  await page.mouse.move(grown.x + grown.width - 62, grown.y + grown.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const narrowed = (await popup.boundingBox())!;
  expect(narrowed.width).toBeCloseTo(grown.width - 60, 0);
  expect(narrowed.height).toBeCloseTo(grown.height, 0);
  await expect(popup).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  popup = await openBranches(page);
  const reopened = (await popup.boundingBox())!;
  expect(reopened.width).toBeCloseTo(narrowed.width, 0);
  expect(reopened.height).toBeCloseTo(narrowed.height, 0);
});
