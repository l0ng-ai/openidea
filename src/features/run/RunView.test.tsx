import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { debugSession, resetRuns, useRun, type RunSession } from "./store";
import { sessionIcon } from "./RunView";

const actions = vi.hoisted(() => ({ executeAction: vi.fn() }));
vi.mock("@/platform/actions", async (orig) => ({ ...(await orig<object>()), executeAction: actions.executeAction }));

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "c",
  name: "c",
  kind: "spring-boot",
  command: "mvn",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

const session = (extra: Partial<RunSession> = {}): RunSession => ({
  id: "s1",
  config: config(),
  runId: null,
  status: "finished",
  exitCode: 0,
  startedAt: 0,
  endedAt: 1,
  stdinClosed: false,
  ...extra,
});

describe("sessionIcon", () => {
  it("shows the execution arrow while running, the check for tests", () => {
    expect(sessionIcon(session({ status: "running" }))).toBe("run");
    expect(sessionIcon(session({ status: "starting" }))).toBe("run");
    expect(sessionIcon(session({ status: "starting", config: config({ isTest: true }) }))).toBe("check");
  });

  it("shows the red error icon for a failed exit", () => {
    expect(sessionIcon(session({ status: "failed" }))).toBe("error");
    expect(sessionIcon(session({ exitCode: 1 }))).toBe("error");
  });

  it("shows the configuration's own icon once the process ended (IDEA's third state)", () => {
    expect(sessionIcon(session())).toBe("spring-boot");
    expect(sessionIcon(session({ config: config({ kind: "program" }) }))).toBe("file-binary");
    expect(sessionIcon(session({ config: config({ kind: "npm" }) }))).toBe("file-npm");
  });

  it("never shows the error icon for a session the user stopped", () => {
    expect(sessionIcon(session({ exitCode: 1, stopped: true }))).toBe("spring-boot");
  });
});

describe("debugSession", () => {
  beforeEach(() => {
    resetRuns();
    actions.executeAction.mockClear();
  });

  it("launches the session's configuration through run.debugConfig", () => {
    const c = config();
    useRun.setState({ sessions: [session({ config: c })] });
    debugSession("s1");
    expect(actions.executeAction).toHaveBeenCalledWith("run.debugConfig", c);
  });

  it("prefers the original configuration of a derived run", () => {
    const base = config({ id: "base" });
    useRun.setState({ sessions: [session({ config: config({ id: "derived" }), baseConfig: base })] });
    debugSession("s1");
    expect(actions.executeAction).toHaveBeenCalledWith("run.debugConfig", base);
  });

  it("ignores unknown session ids", () => {
    debugSession("nope");
    expect(actions.executeAction).not.toHaveBeenCalled();
  });
});
