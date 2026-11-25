import type { AttachableProcess } from "../src/bindings";
import { expect, stubDesktop, test } from "./fixtures";

test("keeps the process columns and selection visible in a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 460, height: 440 });
  await stubDesktop(page);
  const processes: AttachableProcess[] = [
    {
      pid: 4100,
      name: "java",
      commandLine: "java -jar /sample/invoice-service.jar",
      kind: "java",
      adapter: "java",
      host: "localhost",
      port: 5005,
    },
    ...Array.from({ length: 24 }, (_, i): AttachableProcess => ({
      pid: 4201 + i,
      name: `invoice-worker-${i + 1}`,
      commandLine: `node /sample/services/long-package-name/invoice-worker.js --stage settlement-runner-${i + 1}`,
      kind: "node",
      adapter: "js-debug",
      host: "localhost",
      port: 9230 + i,
    })),
  ];
  await page.evaluate(async (processes) => {
    window.__ipc.handlers.debug_attachable_processes = () => processes;
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("debug.attachToProcess");
  }, processes);

  const dialog = page.getByRole("dialog", { name: "Attach to process", exact: true });
  const filter = dialog.getByRole("textbox", { name: "Filter processes" });
  await expect(filter).toBeFocused();
  const table = dialog.getByRole("grid", { name: "Processes" });
  const pid = table.getByRole("columnheader", { name: "PID", exact: true });
  await expect(pid).toBeInViewport({ ratio: 1 });
  await expect(table.getByRole("columnheader", { name: "Command line" })).toBeInViewport({ ratio: 1 });

  await filter.fill("settlement-runner");
  for (let i = 1; i < 24; i++) await page.keyboard.press("ArrowDown");
  const last = table.getByRole("row", { name: /^invoice-worker-24 / });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(pid).toBeInViewport({ ratio: 1 });
  await expect(last.getByText(":9253", { exact: true })).toBeVisible();
  await expect(last.getByTitle("localhost:9253", { exact: true })).toBeVisible();
  const lastPid = last.getByRole("gridcell", { name: "4224", exact: true });
  expect((await lastPid.boundingBox())!.x).toBeCloseTo((await pid.boundingBox())!.x, 0);
  const scrollArea = table.getByRole("rowgroup").last();
  expect(await scrollArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await scrollArea.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(filter).toBeFocused();
  await expect(filter).toBeInViewport({ ratio: 1 });
  for (const name of ["Refresh", "Attach", "Cancel"]) {
    await expect(dialog.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  }

  await page.setViewportSize({ width: 1040, height: 680 });
  await expect(last.getByText("localhost:9253", { exact: true })).toBeVisible();
  await filter.fill("unmatched-process");
  await expect(dialog.getByText("No attachable processes match the filter.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Attach", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
