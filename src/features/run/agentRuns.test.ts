import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { agentConfig, agentName } from "./agentConfig";
import { archivedAgentSessions } from "./agentRuns";
import type { RunSession } from "./store";

const plain: RunConfig = {
  id: "npm:dev",
  name: "dev",
  kind: "npm",
  command: "npm",
  args: ["run", "dev"],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
};

function session(id: string, config: RunConfig, status: RunSession["status"], endedAt: number | null): RunSession {
  return { id, config, runId: null, status, exitCode: 0, startedAt: 0, endedAt, stdinClosed: false };
}

describe("agent tabs", () => {
  it("run the command line on pipes, on this machine", () => {
    const config = agentConfig("_agent_build", "cargo build", "/project", { A: "1" });
    expect(agentName(config)).toBe("_agent_build");
    expect(agentName(plain)).toBeNull();
    expect(config).toMatchObject({
      id: "mcp-agent:_agent_build",
      name: "_agent_build",
      command: "cargo build",
      args: [],
      cwd: "/project",
      target: "",
      allowParallel: true,
    });
    expect(config.emulateTerminal).toBeFalsy();
    expect(config.env).toMatchObject({ A: "1" });
    expect(config.params).toHaveProperty("mcp.agentShell");
  });

  it("archive the oldest finished ones beyond the limit, never a running one or another run", () => {
    const agent = (name: string) => agentConfig(name, "true", "/p", {});
    const sessions = [
      session("old", agent("_agent_old"), "finished", 1),
      session("failed", agent("_agent_failed"), "failed", 2),
      session("live", agent("_agent_live"), "running", null),
      session("new", agent("_agent_new"), "finished", 3),
      session("user", plain, "finished", 0),
    ];
    expect(archivedAgentSessions(sessions, 1).map((s) => s.id)).toEqual(["failed", "old"]);
    expect(archivedAgentSessions(sessions, 3)).toEqual([]);
    expect(archivedAgentSessions(sessions, 0).map((s) => s.id)).toEqual(["new", "failed", "old"]);
  });
});
