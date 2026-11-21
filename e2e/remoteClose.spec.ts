import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const CLOSE = "tauri://close-requested";
const DESTROY = "plugin:window|destroy";
const CANCEL_CLOSE = "window_group_cancel_close";
const STOP = "remote_stop_backend";

interface CloseOptions {
  windows?: number;
  quitting?: boolean;
  dirty?: boolean;
  fail?: boolean;
  idleMinutes?: number | null;
  overrideSeconds?: number | null;
}

async function requestClose(
  page: Page,
  {
    windows = 2,
    quitting = false,
    dirty = false,
    fail = false,
    idleMinutes = 180,
    overrideSeconds = null,
  }: CloseOptions = {},
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ windows, quitting, dirty, fail, idleMinutes, overrideSeconds }) => {
      const closes = "/src/features/app/closeGuard.ts";
      const remote = "/src/platform/remote.ts";
      const project = "/src/platform/project.ts";
      const { installCloseGuard } = await import(/* @vite-ignore */ closes);
      const { enableRemote } = await import(/* @vite-ignore */ remote);
      const { useProject } = await import(/* @vite-ignore */ project);
      enableRemote({
        target: { kind: "ssh", config: "devbox" },
        root: useProject.getState().project.root,
        host: "devbox",
        os: "linux",
        commands: ["doc_close", "remote_idle_timeout_minutes"],
        idlePolicy: { overrideSeconds },
      });
      window.__ipc.handlers.window_close_context = () => ({ windows, quitting });
      window.__ipc.handlers.close_project = () => null;
      window.__ipc.handlers.remote_invoke = ({ cmd }) => {
        if (cmd === "remote_idle_timeout_minutes") {
          if (idleMinutes === null) throw { kind: "unavailable", message: "offline", detail: null };
          return JSON.stringify(idleMinutes);
        }
        return JSON.stringify(null);
      };
      window.__ipc.handlers.window_group_cancel_close = () => null;
      window.__ipc.handlers.app_cancel_quit = () => null;
      window.__ipc.handlers.remote_stop_backend = () => {
        if (fail) throw { kind: "unavailable", message: "Backend did not respond", detail: null };
        return null;
      };
      installCloseGuard();
      if (dirty) window.__ipc.emit({ type: "docDirty", doc: 100, dirty: true });
    },
    { windows, quitting, dirty, fail, idleMinutes, overrideSeconds },
  );
  await expect.poll(async () => (await ipcCalls(page, "plugin:event|listen")).map((e) => e.event)).toContain(CLOSE);
  await page.evaluate((event) => window.__ipc.dispatch(event, null), CLOSE);
  return page.getByRole("dialog", { name: "Close Remote Development Window" });
}

for (const windows of [1, 2]) {
  for (const stop of [false, true]) {
    test(`${stop ? "stops" : "keeps"} the backend on close (${windows === 1 ? "last" : "other"} window)`, async ({
      workbench: page,
    }) => {
      await openFromTree(page, "README.md");
      const dialog = await requestClose(page, { windows });
      await expect(dialog.getByRole("status")).toHaveText("If kept running, the backend stops after 3 hours idle.");
      const keep = dialog.getByRole("button", { name: "Keep Backend Running" });
      await expect(keep).toBeFocused();
      await (stop ? dialog.getByRole("button", { name: "Stop Backend" }) : keep).click();

      const close = windows === 1 ? "close_project" : DESTROY;
      await expect.poll(() => ipcCalls(page, close)).toHaveLength(1);
      const actions = await page.evaluate(
        ({ stop, close }) => window.__ipc.calls.map((c) => c.cmd).filter((cmd) => cmd === stop || cmd === close),
        { stop: STOP, close },
      );
      expect(actions).toEqual(stop ? [STOP, close] : [close]);
      if (windows === 1) await expect(page.getByRole("tree", { name: "Project" })).toHaveCount(0);
    });
  }
}

test("Escape leaves the remote project, backend and window open", async ({ workbench: page }) => {
  const dialog = await requestClose(page, { idleMinutes: 0 });
  await expect(dialog.getByRole("status")).toHaveText("Idle shutdown is off on devbox.");
  await page.keyboard.press("Escape");
  await expect.poll(() => ipcCalls(page, CANCEL_CLOSE)).toHaveLength(1);
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  expect(await ipcCalls(page, STOP)).toHaveLength(0);
  expect(await ipcCalls(page, DESTROY)).toHaveLength(0);
});

test("cancelling unsaved changes after choosing Stop Backend also cancels quit", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  const dialog = await requestClose(page, {
    windows: 1,
    quitting: true,
    dirty: true,
    idleMinutes: 0,
    overrideSeconds: 90,
  });
  await expect(dialog.getByRole("status")).toHaveText("If kept running, the backend stops after 90 seconds idle.");
  expect((await ipcCalls(page, "remote_invoke")).filter((c) => c.cmd === "remote_idle_timeout_minutes")).toHaveLength(
    0,
  );
  await dialog.getByRole("button", { name: "Stop Backend" }).click();
  const unsaved = page.getByRole("dialog", { name: /unsaved changes/i });
  await unsaved.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => ipcCalls(page, "app_cancel_quit")).toHaveLength(1);
  expect(await ipcCalls(page, STOP)).toHaveLength(0);
  expect(await ipcCalls(page, DESTROY)).toHaveLength(0);
});

test("reports a shutdown failure and does not close the window", async ({ workbench: page }) => {
  const dialog = await requestClose(page, { fail: true });
  await dialog.getByRole("button", { name: "Stop Backend" }).click();
  await expect(page.getByText("Could not stop the remote backend")).toBeVisible();
  await expect.poll(() => ipcCalls(page, CANCEL_CLOSE)).toHaveLength(1);
  expect(await ipcCalls(page, DESTROY)).toHaveLength(0);
});

test("can disconnect even if the host cannot report its current idle timeout", async ({ workbench: page }) => {
  const dialog = await requestClose(page, { idleMinutes: null });
  await expect(dialog.getByRole("status")).toHaveText("The host’s idle timeout is unavailable.");
  await dialog.getByRole("button", { name: "Keep Backend Running" }).click();
  await expect.poll(() => ipcCalls(page, DESTROY)).toHaveLength(1);
});

test("Don't Save discards remote edits even when keeping the backend alive", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  const dialog = await requestClose(page, { dirty: true });
  await dialog.getByRole("button", { name: "Keep Backend Running" }).click();
  await page
    .getByRole("dialog", { name: /unsaved changes/i })
    .getByRole("button", { name: /don.t save/i })
    .click();
  await expect.poll(() => ipcCalls(page, DESTROY)).toHaveLength(1);
  expect((await ipcCalls(page, "remote_invoke")).filter((c) => c.cmd === "doc_close")).toEqual([
    expect.objectContaining({ args: '{"doc":100}' }),
  ]);
  expect(await ipcCalls(page, STOP)).toHaveLength(0);
});

async function enablePolicy(page: Page, overrideSeconds: number | null, initialMinutes = 180) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ overrideSeconds, initialMinutes }) => {
      const remote = "/src/platform/remote.ts";
      const project = "/src/platform/project.ts";
      const { enableRemote } = await import(/* @vite-ignore */ remote);
      const { useProject } = await import(/* @vite-ignore */ project);
      const settings = { remoteDevelopment: { idleTimeoutMinutes: initialMinutes } };
      window.__ipc.handlers.settings_get_global = () => ({});
      window.__ipc.handlers.remote_invoke = ({ cmd, args }) => {
        if (cmd === "settings_set") {
          const change = JSON.parse(String(args));
          if (change.scope !== "global" || change.key !== "remoteDevelopment.idleTimeoutMinutes")
            throw new Error("Unexpected settings write");
          settings.remoteDevelopment.idleTimeoutMinutes = JSON.parse(change.value);
        }
        return JSON.stringify(settings);
      };
      enableRemote({
        target: { kind: "ssh", config: "devbox" },
        root: useProject.getState().project.root,
        host: "devbox",
        os: "linux",
        commands: ["settings_get", "settings_get_global", "settings_set"],
        idlePolicy: { overrideSeconds },
      });
      // The Settings window reconciles its global snapshot with the connected host after first paint.
      const staging = "/src/features/settings/model/staging.ts";
      const schema = "/src/features/settings/model/schema.ts";
      (await import(/* @vite-ignore */ staging)).rebaseSettings(
        (await import(/* @vite-ignore */ schema)).validateSettings(settings),
      );
    },
    { overrideSeconds, initialMinutes },
  );
}

for (const override of [null, 90]) {
  test(`remote idle timeout ${override ? "shows the host override read-only" : "is searchable and saves only on Apply"}`, async ({
    workbench: page,
  }) => {
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Idle timeout");
    await dialog.getByRole("treeitem", { name: "Remote Development", exact: true }).click();
    const picker = dialog.getByRole("button", { name: "Stop backend when idle", exact: true });
    await expect(picker).toBeDisabled();
    await enablePolicy(page, override);
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });
    if (override) {
      await expect(dialog.getByText("90 seconds", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Set by OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS on devbox.")).toBeVisible();
      await expect(picker).toHaveCount(0);
      await expect(apply).toBeDisabled();
    } else {
      await expect(picker).toHaveText("After 3 hours (default)");
      await picker.click();
      const options = page.getByRole("listbox").getByRole("option");
      expect(await options.allTextContents()).toEqual([
        "After 30 minutes",
        "After 1 hour",
        "After 3 hours (default)",
        "After 8 hours",
        "After 1 day",
        "Custom…",
        "Never",
      ]);
      await page.getByRole("option", { name: "After 1 day", exact: true }).click();
      await apply.click();
      await expect(apply).toBeDisabled();
      await picker.click();
      await page.getByRole("option", { name: "Never", exact: true }).click();
      await expect(
        dialog.getByText("Idle shutdown is off on devbox. You can still stop the backend manually."),
      ).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Custom duration" })).toHaveCount(0);
      await apply.click();
      await expect(apply).toBeDisabled();
      const writes = (await ipcCalls(page, "remote_invoke")).filter((c) => c.cmd === "settings_set");
      expect(writes.map((c) => JSON.parse(String(c.args)))).toEqual(
        ["1440", "0"].map((value) => ({ scope: "global", key: "remoteDevelopment.idleTimeoutMinutes", value })),
      );
      expect(await ipcCalls(page, "settings_set")).toHaveLength(0);
    }
  });
}

test("custom idle time preserves 90 minutes across units and accepts only whole-minute durations", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Idle timeout");
  await dialog.getByRole("treeitem", { name: "Remote Development", exact: true }).click();
  await enablePolicy(page, null, 90);
  const amount = dialog.getByRole("textbox", { name: "Custom duration" });
  const unit = dialog.getByRole("button", { name: "Duration unit" });
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  await expect(amount).toHaveValue("90");
  await unit.click();
  await page.getByRole("option", { name: "Hours", exact: true }).click();
  await expect(amount).toHaveValue("1.5");
  await expect(apply).toBeDisabled();
  await unit.click();
  await page.getByRole("option", { name: "Days", exact: true }).click();
  await expect(amount).toHaveValue("0.0625");
  await expect(apply).toBeDisabled();
  for (const invalid of ["0", "0.001", "46"]) {
    await amount.fill(invalid);
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(apply).toBeDisabled();
  }
  await amount.fill("1.5");
  await apply.click();
  await expect(apply).toBeDisabled();
  const writes = (await ipcCalls(page, "remote_invoke")).filter((c) => c.cmd === "settings_set");
  expect(writes.map((c) => JSON.parse(String(c.args)).value)).toEqual(["2160"]);
  const picker = dialog.getByRole("button", { name: "Stop backend when idle" });
  await picker.click();
  await page.getByRole("option", { name: "After 3 hours (default)", exact: true }).click();
  await expect(amount).toHaveCount(0);
  await picker.click();
  await page.getByRole("option", { name: "Custom…", exact: true }).click();
  await expect(amount).toHaveValue("3");
});

test("a same-build takeover notifies the old window and leaves reconnect to the user", async ({ workbench: page }) => {
  await enablePolicy(page, null);
  await page.clock.install();
  await page.evaluate(() => window.__ipc.emit({ type: "remoteConnectionLost", host: "devbox", takenOver: true }));
  await expect(page.getByText("Another window took over this remote session", { exact: true })).toBeVisible();
  await expect(page.getByText(/This window will not reconnect automatically/)).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "Reconnect to Remote Host" });
  await expect(
    prompt.getByText("Reconnecting takes over the remote session and disconnects the other window."),
  ).toBeVisible();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await page.clock.fastForward(25_000);
  expect(await ipcCalls(page, "remote_connect")).toHaveLength(0);
  await expect(page.getByRole("button", { name: "SSH: devbox (disconnected)" })).toBeVisible();
});
