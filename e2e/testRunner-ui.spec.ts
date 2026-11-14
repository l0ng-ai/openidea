import { expect, test } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [140, 320]) {
    test(`test runner keeps status columns aligned in ${theme} at ${width}px`, async ({ workbench: page }) => {
      const id = await page.evaluate(async (theme) => {
        const storePath = "/src/features/run/store.ts";
        const resultsPath = "/src/features/run/testing/index.ts";
        const themePath = "/src/workbench/theme.ts";
        const run = await import(storePath);
        const { TestResults } = await import(resultsPath);
        const { previewTheme } = await import(themePath);
        previewTheme(theme);
        localStorage.setItem("openidea.run.testFilters", JSON.stringify({ showPassed: true, showIgnored: true }));
        await run.startSampleOutput(0, 1);
        const id = run.useRun.getState().activeSession;
        const results = new TestResults();
        results.apply([
          { type: "result", path: ["AlignmentSuite", "passed case"], status: "passed", durationMs: 12 },
          { type: "result", path: ["AlignmentSuite", "failed case"], status: "failed", durationMs: 23 },
          { type: "result", path: ["AlignmentSuite", "ignored case"], status: "skipped" },
          { type: "start", path: ["AlignmentSuite", "running case"] },
        ]);
        results.node(["AlignmentSuite", "pending case"]);
        run.runtime(id).tests = results;
        const state = run.useRun.getState();
        run.useRun.setState({
          sessions: state.sessions.map((s: { id: string; config: object }) =>
            s.id === id ? { ...s, status: "running", config: { ...s.config, isTest: true } } : s,
          ),
          versions: { ...state.versions, [id]: (state.versions[id] ?? 0) + 1 },
        });
        return id;
      }, theme);

      const run = page.getByRole("region", { name: "Run", exact: true });
      const panel = run.getByTestId("tests");
      const tree = panel.getByRole("tree", { name: "Test results" });
      await expect(tree.getByText("pending case", { exact: true })).toBeVisible();
      const bounds = (await panel.boundingBox())!;
      const handle = (await run.getByRole("separator").boundingBox())!;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + width, y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - width)).toBeLessThan(2);
      if (process.env.OPENIDEA_TEST_RUNNER_SHOTS)
        await panel.screenshot({ path: `${process.env.OPENIDEA_TEST_RUNNER_SHOTS}/${theme}-${width}.png` });

      const cases = ["passed case", "failed case", "ignored case", "running case", "pending case"];
      const row = (name: string) => tree.getByRole("treeitem").filter({ hasText: name });
      const checkColumns = async (size: number) => {
        const starts: number[] = [];
        for (const name of cases) {
          const icon = row(name).locator('svg[role="img"], svg[role="status"]');
          const iconBounds = (await icon.boundingBox())!;
          const dimensions = await icon.evaluate((node) => {
            const style = getComputedStyle(node);
            return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
          });
          expect.soft(dimensions.width).toBe(size);
          expect.soft(dimensions.height).toBe(size);
          const label = (await row(name).getByText(name, { exact: true }).boundingBox())!;
          const rowBounds = (await row(name).boundingBox())!;
          starts.push(label.x);
          expect
            .soft(Math.abs(iconBounds.y + iconBounds.height / 2 - (rowBounds.y + rowBounds.height / 2)))
            .toBeLessThan(1);
        }
        expect.soft(Math.max(...starts) - Math.min(...starts)).toBeLessThan(1);
      };
      await checkColumns(16);
      const paneBounds = (await panel.boundingBox())!;
      for (const title of ["Show Passed", "Show Ignored"]) {
        const button = panel.getByRole("button", { name: title, exact: true });
        const rect = (await button.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(paneBounds.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(paneBounds.x + paneBounds.width + 1);
        expect.soft((await button.locator("svg").boundingBox())!.width).toBe(16);
      }
      const fills = await row("failed case")
        .getByRole("img", { name: "Failed", exact: true })
        .locator("[fill]")
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => getComputedStyle(node).fill),
        );
      expect.soft(fills).toContain(theme === "light" ? "rgb(255, 175, 15)" : "rgb(242, 197, 92)");

      await page.evaluate(async () => {
        const path = "/src/ui/iconAppearance.ts";
        (await import(path)).setIconAppearance({ iconSize: 20, rowHeight: 28 });
      });
      await checkColumns(20);
      const before = (await row("running case").getByText("running case", { exact: true }).boundingBox())!.x;
      await page.evaluate(async (id) => {
        const path = "/src/features/run/store.ts";
        const run = await import(path);
        run
          .runtime(id)
          .tests.apply([
            { type: "result", path: ["AlignmentSuite", "running case"], status: "passed", durationMs: 34 },
          ]);
        const state = run.useRun.getState();
        run.useRun.setState({ versions: { ...state.versions, [id]: (state.versions[id] ?? 0) + 1 } });
      }, id);
      await expect(row("running case").getByRole("img", { name: "Passed", exact: true })).toBeVisible();
      expect.soft((await row("running case").getByText("running case", { exact: true }).boundingBox())!.x).toBe(before);
      await page.evaluate(async () => {
        const path = "/src/ui/iconAppearance.ts";
        (await import(path)).setIconAppearance(null);
      });

      const showPassed = panel.getByRole("button", { name: "Show Passed", exact: true });
      await showPassed.focus();
      await page.keyboard.press("Enter");
      await expect(row("passed case")).toHaveCount(0);
      await expect(row("running case")).toHaveCount(0);
      await showPassed.click();
      await expect(row("passed case")).toBeVisible();
      const showIgnored = panel.getByRole("button", { name: "Show Ignored", exact: true });
      await showIgnored.click();
      await expect(row("ignored case")).toHaveCount(0);
      await showIgnored.click();
      await expect(row("ignored case")).toBeVisible();
    });
  }
}
