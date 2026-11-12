import { expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import { closeRunTab } from "./RunView";
import { useStackTraces } from "./stackTrace";
import { useRun, type RunSession } from "./store";

const finished = (id: string): RunSession =>
  ({
    id,
    config: { id, name: id, kind: "shell", command: "x", args: [], cwd: null, env: {} } as unknown as RunConfig,
    runId: null,
    status: "finished",
    exitCode: 0,
    startedAt: 0,
  }) as RunSession;

it("hides the Run tool window once its last tab is closed", async () => {
  const hide = vi.fn();
  provideToolWindowService({ hide } as unknown as ToolWindowService);
  useRun.setState({ sessions: [finished("a"), finished("b")] });
  useStackTraces.setState({ tabs: [{ id: "t", title: "Trace", text: "" } as never] });
  await closeRunTab("a", useStackTraces.getState().tabs);
  await closeRunTab("t", useStackTraces.getState().tabs);
  expect(hide).not.toHaveBeenCalled();
  await closeRunTab("b", useStackTraces.getState().tabs);
  expect(hide).toHaveBeenCalledWith("run");
});
