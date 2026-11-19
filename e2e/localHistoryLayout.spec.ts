import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("Local History gives the diff room and keeps revision selection across layouts", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1180, height: 700 });
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const file = "/dev/acme-api/build.gradle.kts";
    const entries = [
      { id: "after", path: file, timestampMs: 2000, label: "Saved", size: 31, kind: "snapshot" },
      { id: "before", path: file, timestampMs: 1000, label: "Original", size: 34, kind: "snapshot" },
    ];
    window.__ipc.handlers.history_list_dir = () => ({ entries, deleted: [] });
    window.__ipc.handlers.history_content = ({ id }) =>
      id === "before" ? 'val reportMode = "summary"\n' : 'val reportMode = "detailed"\n';
    window.__ipc.handlers.vcs_file_mode = () => null;
    window.__ipc.handlers.fs_probe = () => ({ size: 32, binary: false, tooLarge: false });

    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.localHistory", file);
  });

  const revisions = page.getByRole("listbox", { name: "Revisions" });
  await expect(revisions.getByRole("option", { name: /Saved/ })).toBeVisible();
  const separator = page.getByRole("separator", { name: "Revisions" });
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  const initialWidth = (await revisions.boundingBox())!.width;
  await separator.press("ArrowLeft");
  await expect.poll(async () => (await revisions.boundingBox())!.width).toBeLessThan(initialWidth);

  const original = revisions.getByRole("option", { name: /^Original/ });
  await original.click();
  await expect(original).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => ipcCalls(page, "history_content")).toContainEqual({ id: "before" });

  await page.setViewportSize({ width: 480, height: 620 });
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(original).toHaveAttribute("aria-selected", "true");
  const diff = page.locator(".cm-mergeView").filter({ hasText: "summary" });
  await expect(diff).toBeVisible();
  const listBox = (await revisions.boundingBox())!;
  const diffBox = (await diff.boundingBox())!;
  expect(diffBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
  expect(diffBox.width).toBeGreaterThanOrEqual(listBox.width - 2);

  await page.setViewportSize({ width: 1180, height: 700 });
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(original).toHaveAttribute("aria-selected", "true");
});
