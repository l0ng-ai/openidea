import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

const longFile = "QuarterlyReconciliationAndCheckoutAllocation.test.ts";

async function openSplit(page: Page, files: string[], placement: "top" | "bottom") {
  await page.setViewportSize({ width: 720, height: 760 });
  await openFromTree(page, "README.md");
  await page.evaluate(
    async ({ files, placement }) => {
      const projectModule = "/src/platform/project.ts";
      const filesModule = "/src/features/project-tree/fs.ts";
      const editorModule = "/src/editor/core/controller.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);
      const { projectFs } = await import(/* @vite-ignore */ filesModule);
      const { editorController, useTabs } = await import(/* @vite-ignore */ editorModule);
      const { project, settings } = useProject.getState();
      const tabs = { ...settings?.editor?.tabs, placement, multipleRows: false, oneRowOverflow: "scroll" as const };
      useProject.setState({ settings: { ...settings, editor: { ...settings?.editor, tabs } } });
      const paths = files.map((name) => `${project.root}/${name}`);
      for (const path of paths) await projectFs(project.root).createFile(path);
      await editorController().openFilesIn(paths, useTabs.getState().activePane, "right");
    },
    { files, placement },
  );
  return page.locator("section[data-pane-id]").filter({ has: page.getByRole("tab", { name: longFile, exact: true }) });
}

async function expectCloseToFit(tab: Locator) {
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      tab.evaluate((el) => {
        const list = el.closest('[role="tablist"]')!.getBoundingClientRect();
        const close = el.parentElement!.querySelector("[data-tab-close]")!.getBoundingClientRect();
        return close.left >= list.left - 1 && close.right <= list.right + 1;
      }),
    )
    .toBe(true);
}

test("one long editor tab keeps its close button in a narrow single row", async ({ workbench: page }) => {
  const pane = await openSplit(page, [longFile], "top");
  const tab = pane.getByRole("tab", { name: longFile, exact: true });
  await expectCloseToFit(tab);
  await expect(pane.getByRole("button", { name: "Show Hidden Tabs" })).toBeHidden();
  await expect
    .poll(() => tab.getByText(longFile, { exact: true }).evaluate((label) => label.scrollWidth > label.clientWidth))
    .toBe(true);
  await tab.locator("..").getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(tab).toBeHidden();
});

test("the bottom single row keeps a long selected tab visible alongside the hidden tabs picker", async ({
  workbench: page,
}) => {
  const shortFile = "Overview.ts";
  const pane = await openSplit(page, [shortFile, longFile], "bottom");
  const tab = pane.getByRole("tab", { name: longFile, exact: true });
  await expectCloseToFit(tab);
  const more = pane.getByRole("button", { name: "Show Hidden Tabs" });
  await more.click();
  const picker = page.getByRole("grid", { name: "Hidden Editor Tabs" });
  await expect(picker.getByRole("gridcell", { name: shortFile, exact: true })).toBeVisible();
  await expect(picker.getByRole("gridcell", { name: longFile, exact: true })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(pane.getByRole("tab", { name: shortFile, exact: true })).toHaveAttribute("aria-selected", "true");
  await picker.waitFor({ state: "hidden" });
  await pane.getByRole("tab", { name: shortFile, exact: true }).press("End");
  await expectCloseToFit(tab);
});

test("same-name tabs keep the filename beside a shortened directory", async ({ workbench: page }) => {
  const filename = "AllocationRule.ts";
  const first = "qa";
  const second = "backoffice-reconciliation";
  await openSplit(page, [`${first}/${filename}`, `${second}/${filename}`], "top");
  await page.setViewportSize({ width: 900, height: 760 });

  const pane = page.locator("section[data-pane-id]").filter({
    has: page.getByRole("tab").filter({ hasText: second }),
  });
  const selected = pane.getByRole("tab").filter({ hasText: second });
  await expect(selected).toHaveText(`${second}/${filename}`);
  await expectCloseToFit(selected);
  const directory = selected.getByText(`${second}/`, { exact: true });
  const name = selected.getByText(filename, { exact: true });
  await expect.poll(() => directory.evaluate((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth)).toBe(true);
  await expect
    .poll(() =>
      name.evaluate((el) => {
        const text = document.createRange();
        text.selectNodeContents(el);
        return el.getBoundingClientRect().width >= text.getBoundingClientRect().width;
      }),
    )
    .toBe(true);

  await pane.getByRole("button", { name: "Show Hidden Tabs" }).click();
  const picker = page.getByRole("grid", { name: "Hidden Editor Tabs" });
  await expect(picker.getByRole("gridcell").filter({ hasText: `${first}/${filename}` })).toBeVisible();
  await page.keyboard.press("Enter");
  const firstTab = pane.getByRole("tab").filter({ hasText: first });
  await expectCloseToFit(firstTab);
  await expect
    .poll(() =>
      firstTab.getByText(`${first}/`, { exact: true }).evaluate((el) => {
        const text = document.createRange();
        text.selectNodeContents(el);
        return Math.abs(el.clientWidth - text.getBoundingClientRect().width);
      }),
    )
    .toBeLessThanOrEqual(1);

  await firstTab.locator("..").getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveAttribute("aria-selected", "true");
});
