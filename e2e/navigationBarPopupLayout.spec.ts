import { expect, stubDesktop, test } from "./fixtures";

test("the floating navigation list stays beside the visible segment and scrolls to keyboard selection", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 600, height: 560 });
  const folder = "billing";
  const parent =
    "/dev/acme-api/quarterly-settlement-and-reconciliation/merchant-accounts-with-exchange-rate-adjustments";
  const directory = `${parent}/${folder}`;
  const filename = "SettlementSummary.ts";
  const path = `${directory}/${filename}`;
  const long = "QuarterlyReconciliationForPendingSettlementAndCrossBorderMerchantAdjustments.ts";
  const last = "YearEndTotals.ts";
  await page.evaluate(async (path) => {
    const backend = "/src/editor/core/backend.ts";
    (await import(/* @vite-ignore */ backend)).docBackend().files.set(path, "export const pending = 1;\n");
    const service = "/src/workbench/contributions.ts";
    await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
  }, path);
  await expect(page.locator(".cm-content")).toContainText("pending");
  await stubDesktop(page);
  await page.evaluate(
    async ({ directory, filename, long, last }) => {
      window.__ipc.handlers.fs_read_dir = ({ path }) =>
        path === directory
          ? ["archive", long, ...Array.from({ length: 24 }, (_, i) => `Report-${i + 1}.ts`), filename, last].map(
              (name) => ({
                name,
                path: `${directory}/${name}`,
                kind: name === "archive" ? "dir" : "file",
                size: name === "archive" ? 0 : 1,
              }),
            )
          : [];
      const actions = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actions)).executeAction("navigate.navigationBar");
    },
    { directory, filename, long, last },
  );
  const bar = page.getByRole("toolbar", { name: "Navigation bar" });
  await expect(bar).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  const segment = bar.getByRole("button", { name: folder, exact: true });
  await expect(segment).toHaveAttribute("aria-current", "location");
  const barBounds = (await bar.boundingBox())!;
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Children" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: filename, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const bounds = (await list.boundingBox())!;
      return bounds.x >= 5 && bounds.x + bounds.width <= 595;
    })
    .toBe(true);
  expect((await list.boundingBox())!.y).toBeGreaterThanOrEqual(barBounds.y + barBounds.height - 4);
  expect((await bar.boundingBox())!.height).toBeCloseTo(barBounds.height);

  await page.keyboard.press("Home");
  const folderRow = list.getByRole("option", { name: "archive" });
  await expect(folderRow).toHaveAttribute("aria-selected", "true");
  await expect(folderRow).toBeInViewport({ ratio: 1 });
  await expect(list.getByRole("option", { name: long, exact: true }).getByTitle(long)).toBeVisible();
  expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press("End");
  const lastRow = list.getByRole("option", { name: last, exact: true });
  await expect(lastRow).toHaveAttribute("aria-selected", "true");
  await expect(lastRow).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(bar).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

for (const position of ["top", "statusBar"] as const) {
  test(`the ${position} navigation list opens toward the editor and keeps folder navigation`, async ({
    workbench: page,
  }) => {
    const directory = "/dev/acme-api/src";
    const path = `${directory}/Overview.ts`;
    await page.evaluate(async (path) => {
      const backend = "/src/editor/core/backend.ts";
      (await import(/* @vite-ignore */ backend)).docBackend().files.set(path, "export const overview = 1;\n");
      const service = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ service)).editorService().openFile(path);
    }, path);
    await expect(page.locator(".cm-content")).toContainText("overview");
    await stubDesktop(page);
    await page.evaluate(
      async ({ directory, position }) => {
        const archive = `${directory}/archive`;
        window.__ipc.handlers.fs_read_dir = ({ path }) =>
          path === directory
            ? [
                { path: archive, name: "archive", kind: "dir", size: 0 },
                { path: `${directory}/Overview.ts`, name: "Overview.ts", kind: "file", size: 1 },
              ]
            : path === archive
              ? [{ path: `${archive}/Previous.ts`, name: "Previous.ts", kind: "file", size: 1 }]
              : [];
        const source = await (await fetch("/src/workbench/Workbench.tsx")).text();
        const project = source.match(/["'](\/src\/platform\/project\.ts(?:\?[^"']+)?)["']/)?.[1];
        if (!project) throw new Error("Missing project store");
        const { useProject } = await import(/* @vite-ignore */ project);
        const settings = useProject.getState().settings;
        useProject.setState({
          settings: { ...settings, appearance: { ...settings?.appearance, navigationBar: position } },
        });
      },
      { directory, position },
    );
    const anchor = page
      .getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("button", { name: "src", exact: true });
    await anchor.click();
    const list = page.getByRole("listbox", { name: "src", exact: true });
    const archive = list.getByRole("option", { name: "archive" });
    await expect(archive).toHaveAttribute("aria-selected", "true");
    await expect(list).toBeFocused();
    await expect
      .poll(async () => {
        const bounds = (await anchor.boundingBox())!;
        const popup = (await list.boundingBox())!;
        return position === "top" ? popup.y >= bounds.y + bounds.height : popup.y + popup.height <= bounds.y;
      })
      .toBe(true);
    await page.keyboard.press("ArrowRight");
    const nested = page.getByRole("listbox", { name: "archive" });
    await expect(nested.getByRole("option", { name: "Previous.ts" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(archive).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(anchor).toBeFocused();
  });
}
