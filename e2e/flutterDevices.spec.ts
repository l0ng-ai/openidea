/**
 * The Flutter device selector next to the run configuration. The daemon is stubbed at the IPC
 * layer; `crates/ide-flutter` covers its protocol and process.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const device = (id: string, name: string, category: string, unavailable: string | null = null) => ({
  id,
  name,
  platformType: null,
  category,
  emulator: false,
  unavailable,
});
const MACOS = device("macos", "macOS", "desktop");
const CHROME = device("chrome", "Chrome", "web");
const UNAUTHORIZED = device("R5C", "R5C", "mobile", "unauthorized");

async function stubFlutter(page: Page, status: unknown = { kind: "ready" }) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ list }) => {
      const config = {
        id: "flutter:run",
        name: "flutter run",
        kind: "flutter",
        command: "flutter",
        args: ["run", "-t", "lib/main.dart"],
        cwd: null,
        env: {},
        detected: true,
        isTest: false,
        debugAdapter: "dart",
      };
      const h = window.__ipc.handlers;
      h.run_configs = () => [config];
      h.run_apply_settings = (args) => args.configs;
      h.flutter_devices = () => list;
      h.flutter_devices_refresh = () => null;
      h.run_start = () => ({ id: 3, configId: config.id, name: config.name, pid: 42, running: true, pty: false });
      const runModule = "/src/features/run/store.ts";
      const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
      await loadConfigs();
      selectConfig(config.id);
    },
    { list: { status, devices: [MACOS, CHROME, UNAUTHORIZED] } },
  );
}

const chooser = (page: Page) => page.getByRole("button", { name: /^Flutter device:/ });

test("the chosen device is used for Run, and replaced while it is disconnected", async ({ workbench: page }) => {
  await stubFlutter(page);
  await expect(chooser(page)).toContainText("macOS");

  await chooser(page).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "R5C (unauthorized)" })).toBeDisabled();
  await page.getByRole("menuitemcheckbox", { name: "Chrome" }).click();
  await expect(chooser(page)).toContainText("Chrome");

  await page.keyboard.press("Control+r");
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(1);
  const [started] = await ipcCalls(page, "run_start");
  expect((started!.config as { args: string[] }).args).toEqual(["run", "-t", "lib/main.dart", "-d", "chrome"]);

  const emit = (devices: unknown[]) =>
    page.evaluate(
      (devices) => window.__ipc.emit({ type: "flutterDevices", list: { status: { kind: "ready" }, devices } }),
      devices,
    );
  await emit([MACOS]);
  await expect(chooser(page)).toContainText("macOS");
  await emit([MACOS, CHROME]);
  await expect(chooser(page)).toContainText("Chrome");
});

test("says when the Flutter SDK is missing", async ({ workbench: page }) => {
  await stubFlutter(page, { kind: "notInstalled" });
  await expect(chooser(page)).toContainText("Flutter SDK not found");
});
