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
