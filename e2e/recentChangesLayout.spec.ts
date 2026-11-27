import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("Recent Changes puts aligned dates ahead of the changes and opens the chosen history", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await page.setViewportSize({ width: 480, height: 300 });
  await stubDesktop(page);
  const { file, newest, older } = await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const file = `${root}/build.gradle.kts`;
    const saved = Date.now() - 120_000;
    const earlier = saved - 300_000;
    const entries = [
      { id: "checkpoint", path: root, timestampMs: saved, label: "Before refactor", size: 0, kind: "label" },
      { id: "build", path: file, timestampMs: earlier, label: "Saved", size: 9, kind: "snapshot" },
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `notes-${i}`,
        path: `${root}/src/notes-${i}.txt`,
        timestampMs: earlier - (i + 1) * 60_000,
        label: "Saved",
        size: 9,
        kind: "snapshot",
      })),
    ];
    window.__ipc.handlers.history_list_dir = ({ path }) => ({
      entries: path === root ? entries : entries.filter((entry) => entry.path === path),
      deleted: [],
    });
    window.__ipc.handlers.history_content = () => "plugins {}\n";
    window.__ipc.handlers.fs_probe = () => ({ size: 9, binary: false, tooLarge: false });
    window.__ipc.handlers.vcs_file_mode = () => null;
    const dateModule = "/src/platform/dateFormat.ts";
    const { formatDateTime } = await import(/* @vite-ignore */ dateModule);
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("localHistory.recentChanges");
    return { file, newest: formatDateTime(new Date(saved)), older: formatDateTime(new Date(earlier)) };
  });

  const popup = page.getByRole("dialog", { name: "Recent Changes", exact: true });
  const list = popup.getByRole("listbox", { name: "Recent Changes", exact: true });
  const checkpoint = list.getByRole("option", { name: /Before refactor/ });
  const build = list.getByRole("option", { name: /build\.gradle\.kts/ });
  const firstTime = checkpoint.getByText(newest, { exact: true });
  const secondTime = build.getByText(older, { exact: true });
  const firstLabel = checkpoint.getByText("Before refactor", { exact: true });
  const secondLabel = build.getByText(/build\.gradle\.kts/);
  await expect(firstTime).toHaveCSS("font-size", "13px");
  await expect(secondTime).toBeVisible();
  const time = (await firstTime.boundingBox())!;
  const label = (await firstLabel.boundingBox())!;
  expect(time.x).toBeCloseTo((await secondTime.boundingBox())!.x);
  expect(label.x).toBeCloseTo((await secondLabel.boundingBox())!.x);
  expect(time.x + time.width).toBeLessThan(label.x);
  await expect
    .poll(async () => {
      const box = (await popup.boundingBox())!;
      return Math.max(Math.abs(box.x + box.width / 2 - 240), Math.abs(box.y + box.height / 2 - 150));
    })
    .toBeLessThan(2);

  await page.keyboard.press("End");
  const last = list.getByRole("option", { name: /notes-17\.txt/ });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(popup.getByText("Recent Changes", { exact: true })).toBeVisible();

  await page.keyboard.type("build.gradle");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(build).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect.poll(async () => ipcCalls(page, "history_list_dir")).toContainEqual({ path: file });
  await expect(page.getByRole("listbox", { name: "Revisions", exact: true })).toBeVisible();
});
