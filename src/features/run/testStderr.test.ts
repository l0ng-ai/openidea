import { beforeEach, expect, it, vi } from "vitest";
import type { OutputChunk, RunConfig } from "@/platform/ipc";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(async (_config: RunConfig, _channel: unknown) => ({ status: "ok", data: { id: 7, pty: false } })),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { useProject } from "@/platform/project";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import { runtime, startRun } from "./store";

// OpenIDEA's JUnit runner and Gradle's test init script report through the same service messages.
const gradle = {
  id: "gradle:test",
  name: "test",
  kind: "gradle",
  command: "./gradlew",
  args: ["test"],
  cwd: null,
  env: {},
  isTest: true,
  showOnStderr: true,
} as unknown as RunConfig;

beforeEach(() => {
  useProject.setState({ settings: null, project: { root: "/p" } as never });
});

it("shows a test's stderr (`testStdErr`) as stderr and reveals the console for it", async () => {
  const show = vi.fn();
  provideToolWindowService({ show, hide: vi.fn(), isVisible: () => false } as unknown as ToolWindowService);
  const session = await startRun(gradle, undefined, undefined, { prepared: true });
  const channel = ipc.runStart.mock.calls[0]![1] as { onmessage: (chunk: OutputChunk) => void };
  show.mockClear();
  channel.onmessage({
    kind: "stdout",
    text: [
      "##teamcity[testStarted name='prints' className='demo.GreeterTest']",
      "##teamcity[testStdOut name='prints' className='demo.GreeterTest' out='out|n']",
      "##teamcity[testStdErr name='prints' className='demo.GreeterTest' out='err|n']",
      "##teamcity[testFinished name='prints' className='demo.GreeterTest' duration='1']",
      "",
    ].join("\n"),
  });
  await vi.waitFor(() =>
    expect(runtime(session!.id)!.console.textChunks()).toEqual([
      { kind: "stdout", text: "out\n" },
      { kind: "stderr", text: "err\n" },
    ]),
  );
  expect(show).toHaveBeenCalledWith("run");
});
