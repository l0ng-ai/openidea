import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function showBuild(page: Page, diagnosticPath: string | null = null) {
  await page.evaluate(async (path) => {
    const storePath = "/src/features/build/store.ts";
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const { useBuildRun } = await import(/* @vite-ignore */ storePath);
    const { showToolWindow } = await import(/* @vite-ignore */ layoutPath);
    useBuildRun.setState({
      title: "Build Project",
      system: "typescript",
      status: "failed",
      durationMs: 1200,
      selected: null,
      lines: [
        { kind: "out", text: "Compiling TypeScript" },
        { kind: "err", text: "Expected a number" },
      ],
      messages: [{ severity: "error", text: "Expected a number", path, range: null, code: null }],
    });
    showToolWindow("build", true);
  }, diagnosticPath);
  const build = page.getByRole("region", { name: "Build", exact: true });
  await expect(build.getByRole("log", { name: "Build output" })).toBeVisible();
  return build;
}

test("Build gives about two thirds of the initial split to output", async ({ workbench: page }) => {
  const build = await showBuild(page);
  const tree = build.locator("[data-panel][id=build-tree]");
  const console = build.locator("[data-panel][id=build-console]");
  const treeWidth = (await tree.boundingBox())!.width;
  const consoleWidth = (await console.boundingBox())!.width;
  expect(treeWidth / (treeWidth + consoleWidth)).toBeCloseTo(0.33, 2);
});

test("Build reserves room for duration and file counts beside long directory paths", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 760, height: 680 });
  const path = "/dev/acme-api/src/services/regional-catalogs/generated/api/development/builders/catalog.ts";
  const build = await showBuild(page, path);
  const root = build.getByRole("treeitem", { name: /^Build Project/ });
  const filename = build.getByTitle(path, { exact: true }).getByText("catalog.ts", { exact: true });
  const counts = build.getByTitle(path, { exact: true }).getByText("1 error", { exact: true });
  const errorSummary = root.getByText("1 error", { exact: true });
  const elapsed = root.getByText("1 s 200 ms", { exact: true });
  await expect(elapsed).toHaveCSS("font-size", "12px");
  await expect(counts).toBeInViewport({ ratio: 1 });
  const textFits = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width <= el.getBoundingClientRect().width;
  };
  expect(await filename.evaluate(textFits)).toBe(true);
  expect(await errorSummary.evaluate(textFits)).toBe(true);
  const [duration, row] = await Promise.all([elapsed.boundingBox(), root.boundingBox()]);
  expect(row!.x + row!.width - duration!.x - duration!.width).toBeLessThan(12);
});

test("Build output and diagnostics respond to a console font change", async ({ workbench: page }) => {
  const build = await showBuild(page);
  const log = build.getByRole("log", { name: "Build output" });
  const rowGap = async () => {
    const first = (await log.getByText("Compiling TypeScript", { exact: true }).boundingBox())!;
    const second = (await log.getByText("Expected a number", { exact: true }).boundingBox())!;
    return second.y - first.y;
  };
  await expect.poll(rowGap).toBe(20);
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        terminal: {
          ...settings?.terminal,
          useEditorFont: false,
          fontFamily: "Fira Code",
          fallbackFontFamily: "Maple Mono NF CN",
          fontSize: 18,
        },
      },
    });
  });
  await expect(log).toHaveCSS("font-size", "18px");
  await expect(log).toHaveCSS("font-family", /"Fira Code".*"Maple Mono NF CN"/);
  await expect.poll(rowGap).toBe(27);
  await build.getByRole("treeitem", { name: "Expected a number", exact: true }).click();
  const diagnostic = build.getByRole("document", { name: "Build message" });
  await expect(diagnostic).toContainText("Expected a number");
  await expect(diagnostic).toHaveCSS("font-size", "18px");
  await expect(diagnostic).toHaveCSS("line-height", "27px");
});
