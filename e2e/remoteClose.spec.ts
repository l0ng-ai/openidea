import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const CLOSE = "tauri://close-requested";
const DESTROY = "plugin:window|destroy";
const CANCEL_CLOSE = "window_group_cancel_close";
const STOP = "remote_stop_backend";

async function requestClose(page: Page, { windows = 2, quitting = false, dirty = false, fail = false } = {}) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ windows, quitting, dirty, fail }) => {
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
        commands: ["doc_close"],
      });
      window.__ipc.handlers.window_close_context = () => ({ windows, quitting });
      window.__ipc.handlers.close_project = () => null;
      window.__ipc.handlers.remote_invoke = () => JSON.stringify(null);
      window.__ipc.handlers.window_group_cancel_close = () => null;
      window.__ipc.handlers.app_cancel_quit = () => null;
      window.__ipc.handlers.remote_stop_backend = () => {
        if (fail) throw { kind: "unavailable", message: "Backend did not respond", detail: null };
        return null;
      };
      installCloseGuard();
      if (dirty) window.__ipc.emit({ type: "docDirty", doc: 100, dirty: true });
    },
    { windows, quitting, dirty, fail },
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
  const dialog = await requestClose(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => ipcCalls(page, CANCEL_CLOSE)).toHaveLength(1);
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  expect(await ipcCalls(page, STOP)).toHaveLength(0);
  expect(await ipcCalls(page, DESTROY)).toHaveLength(0);
});

test("cancelling unsaved changes after choosing Stop Backend also cancels quit", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  const dialog = await requestClose(page, { windows: 1, quitting: true, dirty: true });
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

async function enablePolicy(page: Page, overrideSeconds: number | null) {
  await stubDesktop(page);
  await page.evaluate(async (overrideSeconds) => {
    const remote = "/src/platform/remote.ts";
    const project = "/src/platform/project.ts";
    const { enableRemote } = await import(/* @vite-ignore */ remote);
    const { useProject } = await import(/* @vite-ignore */ project);
    const settings = { remoteDevelopment: { idleTimeoutMinutes: 180 } };
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
  }, overrideSeconds);
}

for (const override of [null, 90]) {
  test(`remote idle timeout ${override ? "shows the host override read-only" : "is searchable and saves only on Apply"}`, async ({
    workbench: page,
  }) => {
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Idle timeout");
    await dialog.getByRole("treeitem", { name: "Remote Development", exact: true }).click();
    const field = dialog.getByRole("textbox", { name: "Idle timeout", exact: true });
    await expect(field).toBeDisabled();
    await enablePolicy(page, override);
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });
    if (override) {
      await expect(dialog.getByText("90 seconds", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Set by OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS on devbox.")).toBeVisible();
      await expect(field).toHaveCount(0);
      await expect(apply).toBeDisabled();
    } else {
      await expect(field).toHaveValue("180");
      await field.fill("0");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(apply).toBeDisabled();
      await field.fill("45");
      await apply.click();
      await expect(apply).toBeDisabled();
      await expect(field).toHaveValue("45");
      const writes = (await ipcCalls(page, "remote_invoke")).filter((c) => c.cmd === "settings_set");
      expect(writes.map((c) => JSON.parse(String(c.args)))).toEqual([
        { scope: "global", key: "remoteDevelopment.idleTimeoutMinutes", value: "45" },
      ]);
      expect(await ipcCalls(page, "settings_set")).toHaveLength(0);
    }
  });
}

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
