import type { Page } from "@playwright/test";
import { expect, PROJECT, stubDesktop, test } from "./fixtures";

async function importCoverage(page: Page, width: number) {
  await page.setViewportSize({ width: 1050, height: 550 });
  await expect(page.getByRole("tree", { name: "Project" }).getByRole("treeitem", { name: PROJECT })).toBeVisible();
  await expect(page.locator("#splash")).toHaveCount(0);
  await stubDesktop(page);
  await page.evaluate(async (width) => {
    const projectModule = "/src/platform/project.ts";
    const actionsModule = "/src/platform/actions.ts";
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    const { setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
    const root = useProject.getState().project.root;
    const files = Array.from({ length: 36 }, (_, i) => ({
      path: root + (i === 0 ? "/src/Ready.ts" : i === 1 ? "/src/Uncovered.ts" : "/src/settlement/Report" + i + ".ts"),
      lines: [],
      linesCovered: i === 0 ? 20 : i,
      linesTotal: i === 0 ? 20 : 60,
      branchesCovered: i === 0 ? 4 : 1,
      branchesTotal: 4,
    }));
    window.__ipc.handlers.coverage_import = ({ path }) => ({
      runner: "lcov",
      hasBranches: path === "/tmp/coverage.lcov",
      files,
    });
    setToolWindowSize("right", width);
    await executeAction("coverage.importReport", "/tmp/coverage.lcov");
  }, width);
}

test("Coverage keeps sortable statistics aligned next to the file tree at sidebar widths", async ({
  workbench: page,
}) => {
  await importCoverage(page, 280);
  const coverage = page.getByRole("region", { name: "Coverage", exact: true });
  const tree = coverage.getByRole("tree", { name: "Coverage" });
  const line = coverage.getByRole("columnheader", { name: "Line, %" });
  const branch = coverage.getByRole("columnheader", { name: "Branch, %" });
  const folder = tree.getByRole("treeitem", { name: /^settlement/ });
  const ready = tree.getByRole("treeitem", { name: /^Ready\.ts/ });
  await expect(ready).toBeVisible();
  await expect(branch).toBeInViewport({ ratio: 1 });
  await expect.poll(() => tree.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);

  const lineLeft = (await line.boundingBox())!.x;
  const branchLeft = (await branch.boundingBox())!.x;
  for (const row of [ready, folder]) {
    const cells = await row.getByTitle(/% \(/).all();
    expect(cells).toHaveLength(2);
    expect((await cells[0]!.boundingBox())!.x).toBeCloseTo(lineLeft, 0);
    expect((await cells[1]!.boundingBox())!.x).toBeCloseTo(branchLeft, 0);
  }

  await branch.click();
  await expect(branch).toHaveAttribute("aria-sort", "descending");
  await expect(tree.getByRole("treeitem").nth(1)).toHaveAccessibleName(/^Ready\.ts/);
  await folder.locator("[data-tree-toggle]").click();
  const nested = tree.getByRole("treeitem", { name: /^Report/ }).first();
  await expect(nested).toBeVisible();
  expect(await tree.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await tree.evaluate((element) => element.clientHeight),
  );
  expect((await nested.getByTitle("25% (1/4)").boundingBox())!.x).toBeCloseTo((await branch.boundingBox())!.x, 0);
  expect((await nested.getByTitle(/^Report/).boundingBox())!.width).toBeGreaterThan(30);

  await page.evaluate(async () => {
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("coverage.importReport", "/tmp/lines.lcov");
  });
  await expect(branch).toHaveCount(0);
  await expect(line).toBeVisible();
  expect((await ready.getByTitle("100% (20/20)").boundingBox())!.x).toBeCloseTo((await line.boundingBox())!.x, 0);
});

test("Coverage column widths follow the dividers and survive a narrower dock and reload", async ({
  workbench: page,
}) => {
  await importCoverage(page, 460);
  const coverage = page.getByRole("region", { name: "Coverage", exact: true });
  const line = coverage.getByRole("columnheader", { name: "Line, %" });
  const branch = coverage.getByRole("columnheader", { name: "Branch, %" });
  const lineDivider = coverage.getByRole("separator", { name: "Resize Line, % column" });
  const branchDivider = coverage.getByRole("separator", { name: "Resize Branch, % column" });
  const ready = coverage.getByRole("treeitem", { name: /^Ready\.ts/ });
  const nameHeader = coverage.getByRole("columnheader", { name: "Element" });
  await expect(lineDivider).toBeVisible();
  const width = async (loc: typeof line) => (await loc.boundingBox())!.width;
  const originalLine = await width(line);
  const originalBranch = await width(branch);
  const originalName = await width(nameHeader);
  const drag = (await lineDivider.boundingBox())!;
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.width / 2 + 32, drag.y + drag.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => width(line)).toBeCloseTo(originalLine - 32, 0);
  await expect.poll(() => width(nameHeader)).toBeCloseTo(originalName + 32, 0);
  await expect.poll(() => width(branch)).toBeCloseTo(originalBranch, 0);
  await expect(line).toHaveAttribute("aria-sort", "none");

  await branchDivider.press("ArrowRight");
  await expect.poll(() => width(branch)).toBeCloseTo(originalBranch - 10, 0);
  await expect.poll(() => width(line)).toBeCloseTo(originalLine - 22, 0);
  expect((await ready.getByTitle("100% (20/20)").boundingBox())!.x).toBeCloseTo((await line.boundingBox())!.x, 0);

  const resizeDock = (size: number) =>
    page.evaluate(async (size) => {
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const { setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
      setToolWindowSize("right", size);
    }, size);
  await resizeDock(240);
  await expect.poll(() => width(line)).toBeLessThan(originalLine - 22);
  const tree = coverage.getByRole("tree", { name: "Coverage" });
  await expect.poll(() => tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await expect(branchDivider).toBeInViewport({ ratio: 1 });
  await resizeDock(460);
  await expect.poll(() => width(line)).toBeCloseTo(originalLine - 22, 0);
  await expect.poll(() => width(branch)).toBeCloseTo(originalBranch - 10, 0);

  await page.reload();
  await importCoverage(page, 460);
  await expect.poll(() => width(line)).toBeCloseTo(originalLine - 22, 0);
  await expect.poll(() => width(branch)).toBeCloseTo(originalBranch - 10, 0);
  await branchDivider.dblclick();
  await expect.poll(() => width(line)).toBeCloseTo(originalLine, 0);
  await expect.poll(() => width(branch)).toBeCloseTo(originalBranch, 0);
});
