import { expect, stubDesktop, test } from "./fixtures";

test("Coverage keeps sortable statistics aligned next to the file tree at sidebar widths", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1050, height: 550 });
  await stubDesktop(page);
  await page.evaluate(async () => {
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
    setToolWindowSize("right", 280);
    await executeAction("coverage.importReport", "/tmp/coverage.lcov");
  });

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
