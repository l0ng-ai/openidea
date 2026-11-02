import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  useDebugRunSessions,
  type ToolWindowService,
} from "@/workbench/contributions";
import { resetRuns, startRun, useRun, type RunSession } from "./store";

const confirm = vi.hoisted(() => vi.fn(async () => true));
const confirmTerminate = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./dialogs", () => ({
  confirmRerun: confirm,
  confirmTerminate,
  promptValue: vi.fn(),
  RunDialogsOverlay: () => null,
}));

const config = (id: string, extra: Partial<RunConfig> = {}): RunConfig => ({
  id,
  name: id,
  kind: "shell",
  command: "x",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

beforeEach(() => {
  resetRuns();
  useDebugRunSessions.setState({ sessions: [] });
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});

describe("Services session origin", () => {
  it("stores the origin of a Services start", async () => {
    const app = config("app");
    const s = await startRun(app, undefined, undefined, { show: false, origin: "services" });
    expect(s?.origin).toBe("services");
    expect(useRun.getState().sessions[0]?.origin).toBe("services");
  });

  it("reruns of a Services session inherit its origin", async () => {
    const app = config("app");
    const s = await startRun(app, undefined, undefined, { show: false, origin: "services" });
    // No options at all: the reused tab keeps the session's origin (exit-notification Rerun, tests…).
    const again = await startRun(app, s!.id);
    expect(again?.origin).toBe("services");
  });

  it("an explicit origin overrides the inherited one", async () => {
    const app = config("app");
    const s = await startRun(app);
    expect(s?.origin).toBeUndefined();
    // Rerunning the same session from Services moves its ownership there.
    const moved = await startRun(app, s!.id, undefined, { show: false, origin: "services" });
    expect(moved?.origin).toBe("services");
  });

  it("never opens the Run window for a Services start, even with focusToolWindow", async () => {
    const show = vi.fn();
    provideToolWindowService({ show, isVisible: () => false } as unknown as ToolWindowService);
    const app = config("app", { focusToolWindow: true });
    await startRun(app, undefined, undefined, { show: false, origin: "services" });
    expect(show).not.toHaveBeenCalled();
  });

  it("propagates the origin to compound children", async () => {
    const compound = config("all", { kind: "compound", compound: ["a", "b"] });
    const a = config("a"),
      b = config("b");
    useRun.setState({ configs: [compound, a, b] });
    await startRun(compound, undefined, undefined, { show: false, origin: "services" });
    const sessions = useRun.getState().sessions;
    expect(sessions.map((s) => s.config.id).sort()).toEqual(["a", "b"]);
    expect(sessions.every((s: RunSession) => s.origin === "services")).toBe(true);
  });
});
