import { describe, expect, it, vi } from "vitest";
import type { AttachableProcess } from "@/platform/ipc";

vi.mock("../java", () => ({
  javaAttachConfig: vi.fn(async (t: { name: string; hostName: string; port: number }, root: string) => ({
    name: t.name,
    adapter: "java-debug",
    request: "attach",
    program: null,
    args: [],
    cwd: root,
    env: {},
    extraJson: JSON.stringify({ debugServer: 4711, hostName: t.hostName, port: t.port }),
  })),
}));

import { attachConfig, attachDetail, attachRows, matchesFilter } from "../attach";

const proc = (p: Partial<AttachableProcess> & Pick<AttachableProcess, "pid" | "kind">): AttachableProcess => ({
  name: p.kind,
  commandLine: `${p.kind} app`,
  adapter: { unity: "unity", java: "java-debug", node: "js-debug", python: "debugpy", go: "delve", native: "codelldb" }[
    p.kind
  ],
  host: null,
  port: null,
  ...p,
});

const list = [
  proc({ pid: 30, kind: "native", name: "a.out", commandLine: "./a.out" }),
  proc({ pid: 10, kind: "java", name: "java", commandLine: "java -agentlib:jdwp=... -jar shop.jar", port: 5005 }),
  proc({ pid: 20, kind: "python", name: "python3", commandLine: "python3 worker.py" }),
  proc({
    pid: 21,
    kind: "python",
    name: "python3",
    commandLine: "python3 -m debugpy --listen 5678 api.py",
    port: 5678,
  }),
  proc({ pid: 25, kind: "node", name: "node", commandLine: "node server.js" }),
  proc({ pid: 26, kind: "go", name: "gosrv", commandLine: "./gosrv" }),
];

describe("Attach to Process popup model", () => {
  it("attaches the chosen Unity Editor by its exact ID without launching or using a native adapter", async () => {
    const launch = await attachConfig(proc({ pid: 1234, kind: "unity", name: "Unity Editor" }), "/game");
    expect(launch).toMatchObject({ adapter: "unity", request: "attach", program: null, cwd: "/game" });
    expect(JSON.parse(launch.extraJson!)).toEqual({
      name: "Unity Editor (1234)",
      path: "/game/Library/EditorInstance.json",
      __exceptionOptions: [],
    });
  });
  it("groups processes by debugger in IDEA's order with counts", () => {
    const rows = attachRows(list, "");
    expect(rows.filter((r) => r.kind === "group").map((r) => r.kind === "group" && `${r.label}:${r.count}`)).toEqual([
      "Java (JDWP):1",
      "Node.js:1",
      "Python (debugpy):2",
      "Go (Delve):1",
      "Native (LLDB):1",
    ]);
    expect(rows[0]!.kind).toBe("group");
    expect(rows[1]!.kind === "process" && rows[1]!.process.pid).toBe(10);
  });

  it("filters on pid, name and command line (all words)", () => {
    expect(matchesFilter(list[2]!, "worker")).toBe(true);
    expect(matchesFilter(list[2]!, "20")).toBe(true);
    expect(matchesFilter(list[2]!, "python api")).toBe(false);
    const rows = attachRows(list, "debugpy");
    expect(rows.map((r) => r.key)).toEqual(["group:python", "python:21"]);
    expect(attachRows(list, "nothing-matches")).toEqual([]);
  });

  it("describes how each process is reached", () => {
    expect(attachDetail(list[1]!)).toBe("localhost:5005");
    expect(attachDetail(list[2]!)).toBe("pid 20");
  });

  it("builds the attach request of each debugger", async () => {
    const extra = async (p: AttachableProcess) => JSON.parse((await attachConfig(p, "/proj")).extraJson!);
    const java = await attachConfig(list[1]!, "/proj");
    expect(java.adapter).toBe("java-debug");
    expect(JSON.parse(java.extraJson!)).toMatchObject({ hostName: "localhost", port: 5005 });
    // debugpy: inject by pid, or talk to a `--listen` adapter directly.
    expect(await extra(list[2]!)).toMatchObject({ processId: 20 });
    expect(await extra(list[3]!)).toMatchObject({ debugServer: 5678 });
    // js-debug: the backend opens the inspector of a process started without --inspect.
    expect(await extra(list[4]!)).toMatchObject({ type: "pwa-node", processId: "25" });
    expect(await extra(proc({ pid: 27, kind: "node", port: 9230 }))).toMatchObject({
      port: 9230,
      address: "localhost",
    });
    expect(await extra(list[5]!)).toEqual({ mode: "local", processId: 26 });
    const native = await attachConfig(list[0]!, "/proj");
    expect(native).toMatchObject({ adapter: "codelldb", request: "attach", name: "a.out (30)", cwd: "/proj" });
    expect(JSON.parse(native.extraJson!)).toEqual({ pid: 30 });
  });
});
