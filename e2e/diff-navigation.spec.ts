import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openChain(page: Page) {
  await page.evaluate(async () => {
    const inputPath = "/src/features/vcs/diffInput.ts";
    const { openDiff, withChain } = await import(inputPath);
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "split", collapse: false }));
    const files = ["a.ts", "b.ts"].map((name) => ({
      path: `/dev/acme-api/${name}`,
      left: { type: "text", text: "same\nbefore\ntail\n", label: "HEAD" },
      right: { type: "text", text: "same\nafter\ntail\n", label: "Working tree" },
    }));
    await openDiff(withChain(files, 0), { preview: true });
  });
  const toolbar = page.getByRole("toolbar", { name: "Diff", exact: true });
  await expect(toolbar).toContainText("1 difference");
  return toolbar;
}

test("maximizes a diff preview tab and restores its previous layout", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  const viewer = toolbar.locator("..");
  const project = page.getByRole("tree", { name: "Project", exact: true });
  await expect(project).toBeVisible();
  const before = (await viewer.boundingBox())!;
  await toolbar.getByRole("button", { name: "Maximize Editor", exact: true }).click();
  await expect(project).toBeHidden();
  await expect.poll(async () => (await viewer.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  await expect(toolbar).toContainText("1 difference");
  await toolbar.getByRole("button", { name: "Restore Size", exact: true }).click();
  await expect(project).toBeVisible();
  await expect.poll(async () => Math.abs((await viewer.boundingBox())!.width - before.width)).toBeLessThan(2);
  await expect(toolbar).toContainText("1 difference");
});

test("continues between changed files from toolbar buttons and the keymap", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  const selected = page.getByRole("tablist", { name: "Editor tabs" }).locator('[aria-selected="true"]');
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(toolbar).toContainText("1 of 1 differences");
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press again to go to the next file" })).toBeVisible();
  await expect(selected).toContainText("a.ts");
  await page.keyboard.press("F7");
  await expect(selected).toContainText("b.ts");
  await expect(toolbar).toContainText("1 of 1 differences");
  await toolbar.getByRole("button", { name: "Previous Difference", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press again to go to the previous file" })).toBeVisible();
  await toolbar.getByRole("button", { name: "Previous Difference", exact: true }).click();
  await expect(selected).toContainText("a.ts");
  await expect(toolbar).toContainText("1 of 1 differences");
});
