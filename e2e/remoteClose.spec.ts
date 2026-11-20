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
