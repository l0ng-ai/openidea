import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  sdkPhpComposerInstall: vi.fn(),
  runApplySettings: vi.fn(),
}));
const run = vi.hoisted(() => ({ startRun: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));
vi.mock("./store", () => run);

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useEditorBanners } from "@/workbench/contributions";
import { composerInstallConfig, registerComposerInstall } from "./composerInstall";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
/** The banner hook of the file at `path`, as an open editor renders it. */
const render = (path: string) => {
  const { useBanner } = useEditorBanners.getState().banners.get("php.composerInstall")!;
  return renderHook(() => useBanner(path));
};

let dispose: () => void;
beforeEach(() => {
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  ipc.sdkPhpComposerInstall.mockImplementation((path: string) =>
    ok(path.startsWith("/p/app/") ? { root: "/p/app", reason: "missing" } : null),
  );
  ipc.runApplySettings.mockImplementation((configs: RunConfig[]) =>
    ok(configs.map((c) => ({ ...c, env: { PATH: "/php/bin" } }))),
  );
  dispose = registerComposerInstall();
});
afterEach(() => {
  cleanup();
  dispose();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

it("offers composer install above the PHP files and composer.json of a project without vendor/", async () => {
  const php = render("/p/app/src/Kernel.php");
  await waitFor(() => expect(php.result.current?.text).toBe("Composer dependencies are not installed"));
  const json = render("/p/app/composer.json");
  await waitFor(() => expect(json.result.current?.actions?.map((a) => a.label)).toEqual(["Install", "Ignore"]));
  expect(render("/p/app/README.md").result.current).toBeNull();
  expect(ipc.sdkPhpComposerInstall).not.toHaveBeenCalledWith("/p/app/README.md");

  act(() => php.result.current!.actions![0]!.run());
  await waitFor(() => expect(run.startRun).toHaveBeenCalled());
  // Settings apply first, so the configured PHP is on PATH.
  expect(ipc.runApplySettings).toHaveBeenCalledWith([composerInstallConfig("/p/app")]);
  expect(run.startRun.mock.calls[0]![0]).toMatchObject({ command: "composer", args: ["install"], cwd: "/p/app" });
  expect(run.startRun.mock.calls[0]![0].env).toEqual({ PATH: "/php/bin" });
});

it("hides the banner once ignored, and in an untrusted project", async () => {
  const php = render("/p/app/src/Kernel.php");
  await waitFor(() => expect(php.result.current).not.toBeNull());
  act(() => php.result.current!.actions![1]!.run());
  expect(php.result.current).toBeNull();
  expect(render("/p/app/composer.json").result.current).toBeNull();

  cleanup();
  dispose();
  useProject.setState({ project: { root: "/q", trusted: false } as never });
  dispose = registerComposerInstall();
  expect(render("/q/index.php").result.current).toBeNull();
  expect(ipc.sdkPhpComposerInstall).not.toHaveBeenCalledWith("/q/index.php");
});
