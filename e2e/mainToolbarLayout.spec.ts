import { expect, stubDesktop, test } from "./fixtures";

const projectName = "Regional Order Fulfillment and Payments";
const runName = "Fulfillment Integration Checkout Suite";

test("the main toolbar compresses long labels before a short branch name", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(
    async ({ projectName, runName }) => {
      const platform = "/src/platform/platformInfo.ts";
      const project = "/src/platform/project.ts";
      const vcs = "/src/features/vcs/store.ts";
      const run = "/src/features/run/store.ts";
      const { usePlatform } = await import(/* @vite-ignore */ platform);
      const { useProject } = await import(/* @vite-ignore */ project);
      const { useVcs } = await import(/* @vite-ignore */ vcs);
      const { useRun } = await import(/* @vite-ignore */ run);
      usePlatform.setState({ os: "windows", framelessTitleBar: true, overlayTitleBar: false });
      useProject.setState({ project: { ...useProject.getState().project, displayName: projectName } });
      useVcs.setState({
        available: true,
        branch: { head: "main", headCommit: "a".repeat(40), upstream: null, ahead: 0, behind: 0, operation: null },
      });
      useRun.setState({
        loaded: true,
        selectedId: "test",
        configs: [
          {
            id: "test",
            name: runName,
            kind: "shell",
            command: "node",
            args: [],
            cwd: null,
            env: {},
            detected: false,
            isTest: false,
            debugAdapter: null,
          },
        ],
      });
    },
    { projectName, runName },
  );

  const toolbar = page.locator("header").first();
  const project = toolbar.getByText(projectName, { exact: true });
  const branch = toolbar.getByText("main", { exact: true });
  const run = toolbar.getByText(runName, { exact: true });
  const width = (label: typeof project) =>
    label.evaluate((element) => ({ shown: element.clientWidth, preferred: element.scrollWidth }));
  const labels = [project, branch, run];

  await page.setViewportSize({ width: 1150, height: 620 });
  const expanded = await Promise.all(labels.map(width));
  await page.setViewportSize({ width: 690, height: 620 });
  await expect.poll(async () => (await width(branch)).shown).toBe((await width(branch)).preferred);
  const narrowed = await Promise.all([width(project), width(run)]);
  for (const { shown, preferred } of narrowed) {
    expect(shown).toBeGreaterThan(35);
    expect(shown).toBeLessThan(preferred);
  }
  expect(Math.abs(narrowed[0]!.shown - narrowed[1]!.shown)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 400, height: 550 });
  const buttons = toolbar.locator("button:visible");
  await expect
    .poll(async () =>
      buttons.evaluateAll((elements) => {
        const bounds = elements
          .filter((element) => getComputedStyle(element).visibility === "visible")
          .map((element) => ({
            label: element.getAttribute("aria-label") ?? element.textContent,
            rect: element.getBoundingClientRect(),
          }))
          .filter(({ rect }) => rect.width > 0)
          .sort((a, b) => a.rect.left - b.rect.left);
        return bounds
          .filter(
            ({ rect }, i) =>
              rect.left < 0 || rect.right > innerWidth || rect.left < (bounds[i - 1]?.rect.right ?? 0) - 1,
          )
          .map(({ label, rect }) => [label, rect.left, rect.right]);
      }),
    )
    .toEqual([]);
  await expect.poll(async () => (await Promise.all(labels.map(width))).map(({ shown }) => shown)).toEqual([0, 0, 0]);

  const chooser = toolbar.locator("[data-run-chooser]");
  await chooser.press("Enter");
  const configs = page.getByRole("dialog", { name: "Run/Debug Configurations" });
  await expect(configs.getByRole("option", { name: new RegExp(`^${runName}`), selected: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1150, height: 620 });
  await expect.poll(() => Promise.all(labels.map(width))).toEqual(expanded);
});
