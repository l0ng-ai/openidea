import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openDiff(page: Page, mode: "split" | "unified") {
  const source = Array.from({ length: 62 }, (_, index) => `const item${index + 1} = ${index + 1};`).join("\n");
  const updated = source.replace("item12 = 12", "item12 = 120").replace("item49 = 49", "item49 = 490");
  await page.evaluate(
    async ({ mode, source, updated }) => {
      localStorage.setItem(
        "openidea.vcs.diffOptions",
        JSON.stringify({ mode, collapse: true, alignChanges: true, highlight: "words", syncScroll: true }),
      );
      const path = "/src/platform/actions.ts";
      await (
        await import(/* @vite-ignore */ path)
      ).executeAction("diff.compareTexts", {
        path: "items.ts",
        title: "items.ts",
        left: { text: source, label: "Before" },
        right: { text: updated, label: "After" },
      });
    },
    { mode, source, updated },
  );
  await expect(page.getByRole("toolbar", { name: "Diff" })).toBeVisible();
}

test("side-by-side unchanged separators expand both panes from the keyboard", async ({ workbench: page }) => {
  await openDiff(page, "split");
  const left = page.locator(".cm-merge-a");
  const right = page.locator(".cm-merge-b");
  const row = left.locator(".cm-collapsedLines").first();
  await expect(row).toBeVisible();
  const control = row.getByRole("button", { name: "8 unchanged lines" });
  await expect(control).toBeVisible();
  await expect(control).toHaveCSS("font-size", "13px");
  await expect(right.getByRole("button", { name: "8 unchanged lines" })).toBeVisible();
  await expect(left.locator(".cm-line").getByText("item1", { exact: true })).toBeHidden();

  await control.press("Enter");
  await expect(left.getByRole("button", { name: "8 unchanged lines" })).toBeHidden();
  await expect(right.getByRole("button", { name: "8 unchanged lines" })).toBeHidden();
  await expect(left.locator(".cm-line").getByText("item1", { exact: true })).toBeVisible();
  await expect(right.locator(".cm-line").getByText("item1", { exact: true })).toBeVisible();
  await expect(left.locator(".cm-content")).toBeFocused();
});

test("the unified separator stays legible in a narrow viewer and expands on click", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 640, height: 650 });
  await openDiff(page, "unified");
  const pane = page.locator(".cm-merge-b");
  const first = pane.locator(".cm-collapsedLines").first();
  await expect(first).toBeVisible();
  const control = first.getByRole("button", { name: "8 unchanged lines" });
  await expect(control).toBeInViewport({ ratio: 1 });
  const row = (await first.boundingBox())!;
  const bounds = (await control.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(row.width - 1);
  await control.click();
  await expect(pane.getByRole("button", { name: "8 unchanged lines" })).toBeHidden();
  await expect(pane.locator(".cm-line").getByText("item1", { exact: true })).toBeVisible();
  await expect(pane.locator(".cm-collapsedLines").first()).toBeVisible();
});
