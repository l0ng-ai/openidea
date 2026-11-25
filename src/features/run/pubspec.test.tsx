import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  fsReadDir: vi.fn(),
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
import { pubGetDue, registerPubspecCommands } from "./pubspec";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const err = () => Promise.resolve({ status: "error" as const, error: { kind: "notFound", message: "" } });
const render = (path: string) => {
  const { useBanner } = useEditorBanners.getState().banners.get("dart.pubspec")!;
  return renderHook(() => useBanner(path));
};

/** Modification times of the files on disk. */
let files: Record<string, number>;
let pubspec: string;
let dispose: () => void;
beforeEach(() => {
  pubspec = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";
  files = { "/p/pubspec.yaml": 10, "/p/pubspec.lock": 20, "/p/.dart_tool/package_config.json": 30 };
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  ipc.fsReadText.mockImplementation(() => ok(pubspec));
  ipc.fsReadDir.mockImplementation((dir: string) => {
    const entries = Object.entries(files)
      .filter(([path]) => path.slice(0, path.lastIndexOf("/")) === dir)
      .map(([path, mtimeMs]) => ({ name: path.slice(dir.length + 1), mtimeMs }));
    return entries.length ? ok(entries) : err();
  });
  ipc.runApplySettings.mockImplementation((configs: RunConfig[]) => ok(configs));
  dispose = registerPubspecCommands();
});
afterEach(() => {
  cleanup();
  dispose();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

it("asks for Pub get when the package config is missing or older than the pubspec or lock", () => {
  expect(pubGetDue({ pubspec: 10, lock: 20, config: 30 })).toBeNull();
  expect(pubGetDue({ pubspec: 10, lock: 20, config: null })).toBe("missing");
  expect(pubGetDue({ pubspec: 10, lock: null, config: 30 })).toBe("missing");
  expect(pubGetDue({ pubspec: 40, lock: 20, config: 30 })).toBe("stale");
  expect(pubGetDue({ pubspec: 10, lock: 40, config: 30 })).toBe("stale");
});

it("offers flutter pub commands and Flutter doctor above a Flutter pubspec.yaml", async () => {
  const banner = render("/p/pubspec.yaml");
  await waitFor(() => expect(banner.result.current?.text).toBe("Flutter commands"));
  expect(banner.result.current?.actions?.map((a) => a.label)).toEqual([
    "Pub get",
    "Pub upgrade",
    "Pub outdated",
    "Flutter doctor",
  ]);
  expect(render("/p/lib/main.dart").result.current).toBeNull();

  act(() => banner.result.current!.actions![0]!.run());
  await waitFor(() => expect(run.startRun).toHaveBeenCalled());
  expect(run.startRun.mock.calls[0]![0]).toMatchObject({ command: "flutter", args: ["pub", "get"], cwd: "/p" });
});

it("runs dart pub in a Dart package, without Flutter doctor", async () => {
  pubspec = "name: tool\ndependencies:\n  path: ^1.9.0\n";
  const banner = render("/p/pubspec.yaml");
  await waitFor(() => expect(banner.result.current?.text).toBe("Dart commands"));
  expect(banner.result.current?.actions?.map((a) => a.label)).not.toContain("Flutter doctor");
  act(() => banner.result.current!.actions![1]!.run());
  await waitFor(() => expect(run.startRun).toHaveBeenCalled());
  expect(run.startRun.mock.calls[0]![0]).toMatchObject({ command: "dart", args: ["pub", "upgrade"] });
});

it("shows the Pub get prompt until Pub get succeeds", async () => {
  files["/p/pubspec.yaml"] = 40;
  const banner = render("/p/pubspec.yaml");
  await waitFor(() => expect(banner.result.current?.text).toBe("pubspec.yaml has been edited"));
  expect(banner.result.current?.level).toBe("warning");

  // A failed run keeps it; a successful one clears it, even when pub left the files as they were.
  act(() => banner.result.current!.actions![0]!.run());
  await waitFor(() => expect(run.startRun).toHaveBeenCalled());
  act(() => run.startRun.mock.calls[0]![3].onExit(1, false));
  await waitFor(() => expect(ipc.fsReadText).toHaveBeenCalledTimes(2));
  expect(banner.result.current?.text).toBe("pubspec.yaml has been edited");
  act(() => run.startRun.mock.calls[0]![3].onExit(0, false));
  await waitFor(() => expect(banner.result.current?.text).toBe("Flutter commands"));
  // Deleted afterwards: due again.
  delete files["/p/.dart_tool/package_config.json"];
  act(() => run.startRun.mock.calls[0]![3].onExit(1, false));
  await waitFor(() => expect(banner.result.current?.text).toBe("Pub get has not been run"));
});

it("prompts when Pub get never ran, but not in a workspace member or an untrusted project", async () => {
  delete files["/p/.dart_tool/package_config.json"];
  const banner = render("/p/pubspec.yaml");
  await waitFor(() => expect(banner.result.current?.text).toBe("Pub get has not been run"));

  cleanup();
  dispose();
  pubspec += "resolution: workspace\n";
  dispose = registerPubspecCommands();
  const member = render("/p/pubspec.yaml");
  await waitFor(() => expect(member.result.current?.text).toBe("Flutter commands"));

  cleanup();
  dispose();
  useProject.setState({ project: { root: "/p", trusted: false } as never });
  dispose = registerPubspecCommands();
  expect(render("/p/pubspec.yaml").result.current).toBeNull();
});
