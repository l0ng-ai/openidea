import { expect, openFromTree, stubDesktop, test } from "./fixtures";

const MB = 1024 * 1024;
const GB = 1024 * MB;

test("shows compact remote CPU+RAM pill beside SSH status and opens detailed dashboard", async ({
  workbench: page,
}) => {
  await openFromTree(page, "README.md");
  await stubDesktop(page);

  const statusBar = page.getByRole("contentinfo", { name: "Status bar" });
  await expect(statusBar.getByRole("button", { name: /Remote host resources:/ })).toHaveCount(0);

  await page.evaluate(async () => {
    const MB = 1024 * 1024;
    const GB = 1024 * MB;
    const remoteMod = "/src/platform/remote.ts";
    const projectMod = "/src/platform/project.ts";
    const { enableRemote } = await import(/* @vite-ignore */ remoteMod);
    const { useProject } = await import(/* @vite-ignore */ projectMod);

    let step = 0;
    const series = [
      { cpu: 22, mem: 5.8 * GB, rx: 420 * 1024, tx: 120 * 1024, r: 2 * MB, w: 6 * MB },
      { cpu: 38, mem: 6.2 * GB, rx: 1.8 * MB, tx: 340 * 1024, r: 8 * MB, w: 14 * MB },
      { cpu: 54, mem: 6.6 * GB, rx: 3.4 * MB, tx: 610 * 1024, r: 18 * MB, w: 24 * MB },
      { cpu: 41, mem: 6.4 * GB, rx: 1.2 * MB, tx: 210 * 1024, r: 4 * MB, w: 9 * MB },
    ];
    let endedLsp = false;

    window.__ipc.handlers.remote_invoke = ({ cmd, args }) => {
      const parsed = JSON.parse(String(args ?? "{}")) as { includeProcesses?: boolean; pid?: number };
      if (cmd === "host_end_process") {
        if (parsed.pid === 2048) endedLsp = true;
        return JSON.stringify(true);
      }
      if (cmd === "host_metrics") {
        const pt = series[Math.min(step++, series.length - 1)]!;
        return JSON.stringify({
          cpuPercent: pt.cpu,
          cpuCores: 16,
          loadAverage: [1.42, 1.18, 0.95],
          memoryUsedBytes: pt.mem,
          memoryTotalBytes: 16 * GB,
          netRxBytesPerSec: pt.rx,
          netTxBytesPerSec: pt.tx,
          diskReadBytesPerSec: pt.r,
          diskWriteBytesPerSec: pt.w,
          diskAvailableBytes: 84 * GB,
          diskTotalBytes: 200 * GB,
          uptimeMs: 9_840_000,
          processes: parsed.includeProcesses
            ? [
                {
                  category: "app",
                  label: "Backend",
                  detail: null,
                  pid: 1024,
                  processes: 1,
                  bytes: 54 * MB,
                  cpuPercent: 2.1,
                },
                ...(endedLsp
                  ? []
                  : [
                      {
                        category: "languageServer",
                        label: "rust-analyzer",
                        detail: "acme-api",
                        pid: 2048,
                        processes: 2,
                        bytes: 1450 * MB,
                        cpuPercent: 34.5,
                      },
                    ]),
                {
                  category: "process",
                  label: "pnpm run dev",
                  detail: "Run",
                  pid: 3072,
                  processes: 4,
                  bytes: 410 * MB,
                  cpuPercent: 11.2,
                },
              ]
            : [],
          externalProcesses: parsed.includeProcesses
            ? [{ pid: 9100, name: "dockerd", cpuPercent: 5.4, memoryBytes: 780 * MB }]
            : [],
        });
      }
      return JSON.stringify(null);
    };

    enableRemote({
      target: { kind: "ssh", config: "thinkpad" },
      root: useProject.getState().project?.root ?? "/home/deng/acme-api",
      host: "deng@deng-thinkpad.local",
      os: "linux",
      commands: ["host_metrics", "host_end_process"],
      idlePolicy: null,
      takenOver: false,
    });
  });

  await expect(statusBar.getByRole("button", { name: "SSH: deng@deng-thinkpad.local" })).toBeVisible();
  const pill = statusBar.getByRole("button", { name: /Remote host resources:/ });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("22% · 5.8G");

  // Sits immediately to the right of the Remote Host status bar item.
  const leftOrder = await statusBar
    .locator(":scope > [data-status-item]")
    .evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.dataset.statusItem));
  expect(leftOrder.slice(0, 2)).toEqual(["remote.location", "remote.resources"]);

  await pill.click();
  const dialog = page.getByRole("dialog", { name: "Remote Host Resources" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("SSH: deng@deng-thinkpad.local")).toBeVisible();
  await expect(dialog.getByText("16 cores · load 1.42 · 1.18 · 0.95")).toBeVisible();
  await expect(dialog.getByText("84 GB free")).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Language servers" })).toContainText("rust-analyzer");
  await expect(dialog.getByRole("group", { name: "Other host processes" })).toContainText("dockerd");

  // Hover, cancel confirmation first, then confirm ending the remote language server process.
  const lspRow = dialog.locator("[title='PID 2048 · 2 processes']");
  await lspRow.hover();
  await lspRow.getByRole("button", { name: "End Process rust-analyzer" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "End Remote Process" });
  await expect(confirmDialog).toContainText("End 'rust-analyzer' (PID 2048) and its child processes");
  await confirmDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Language servers" })).toContainText("rust-analyzer");

  await lspRow.hover();
  await lspRow.getByRole("button", { name: "End Process rust-analyzer" }).click();
  await page.getByRole("dialog", { name: "End Remote Process" }).getByRole("button", { name: "End Process" }).click();
  await expect(dialog.getByRole("group", { name: "Language servers" })).toHaveCount(0);

  // Escape dismisses the popover while keeping the status bar pill live.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(pill).toBeVisible();

  // Disconnecting removes the remote resource pill cleanly.
  await page.evaluate(async () => {
    const remoteMod = "/src/platform/remote.ts";
    const { disableRemote } = await import(/* @vite-ignore */ remoteMod);
    disableRemote();
  });
  await expect(pill).toHaveCount(0);
  expect(GB).toBeGreaterThan(MB);
});
