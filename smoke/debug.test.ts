/**
 * Debugging each language's `fixtures/` project the way the editor does: a breakpoint on the
 * entry point's "Set a breakpoint here" line, Debug from the file's context, then the paused
 * frame, its variables, evaluation, Step Over and Resume, with the debugger the IDE installs.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { Channel } from "@tauri-apps/api/core";
import { commands, type InstallEvent } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, nextRequestId, onIdeEvent } from "@/platform/ipc";
import { openProject, useProject } from "@/platform/project";
import { activate as activateDebugger } from "@/features/debugger";
import { addBreakpoint } from "@/features/debugger/breakpoints/store";
import { activeSession, evaluate, useDebug } from "@/features/debugger/state";
import { activate as activateRun } from "@/features/run";
import { resetRuns, useRun } from "@/features/run/store";
import { activateWorkbench } from "@/workbench/activate";
import { useNotifications } from "@/workbench/notificationStore";
import { connectDesktop } from "./desktop";
import { repoRoot, Server } from "./server";

interface Case {
  fixture: string;
  /** Runs in the project copy first (installs its dependencies). */
  setup?: (root: string) => void;
  /** The IDE's tool that debugs it. */
  debugger: string;
  /** The entry point, debugged from its context. */
  file: string;
  /** A variable of the paused frame. */
  variable: string;
  /** An expression evaluated there (Evaluate Expression), and its value. */
  evaluate: [string, RegExp];
  /** A server: the breakpoint is in this request's handler, and the session is stopped at the end. */
  request?: string;
}

const CASES: Record<string, Case> = {
  typescript: {
    fixture: "ts-app",
    setup: (root) => execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore" }),
    debugger: "js-debug",
    file: "src/index.ts",
    variable: "cart",
    evaluate: ["cart.items.length", /^2$/],
  },
  python: {
    fixture: "python-app",
    setup: (root) => execFileSync("python3", ["-m", "venv", ".venv"], { cwd: root, stdio: "ignore" }),
    debugger: "debugpy",
    file: "src/tasks/cli.py",
    variable: "tasks",
    evaluate: ["len(tasks.pending())", /^3$/],
  },
  rust: {
    fixture: "rust-app",
    debugger: "codelldb",
    file: "src/main.rs",
    variable: "inventory",
    evaluate: ["inventory", /\S/],
  },
  go: {
    fixture: "go-app",
    debugger: "delve",
    file: "cmd/server/main.go",
    variable: "r",
    evaluate: ["r.Method", /^"GET"$/],
    request: "http://127.0.0.1:8080/notes?q=openidea",
  },
  java: {
    fixture: "java-app",
    debugger: "java-debug",
    file: "src/main/java/com/example/orders/App.java",
    variable: "book",
    evaluate: ["book.size()", /^3$/],
  },
  kotlin: {
    fixture: "kotlin-gradle",
    debugger: "kotlin-debug-adapter",
    file: "src/main/kotlin/com/example/library/App.kt",
    variable: "library",
    evaluate: ["library", /Library/],
  },
};

let deactivate: (() => void) | null = null;
let server: Server | null = null;
let disconnect: (() => void) | null = null;
let base = "";

/** Backend events received, for failure messages. */
const events: string[] = [];
beforeAll(() => {
  onIdeEvent("*", (e) => events.push(e.type === "debug" ? `debug ${e.session} ${e.event.kind}` : e.type));
  const disposers = [activateWorkbench(), activateRun(), activateDebugger()];
  deactivate = () => disposers.reverse().forEach((d) => d());
});
afterAll(() => deactivate?.());

afterEach(() => {
  resetRuns();
  disconnect?.();
  server?.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

async function open(c: Case): Promise<string> {
  base = realpathSync(mkdtempSync(join(tmpdir(), "openidea-smoke-")));
  const root = join(base, c.fixture);
  cpSync(join(repoRoot, "fixtures", c.fixture), root, { recursive: true });
  c.setup?.(root);
  server = await Server.start(join(base, "home"));
  disconnect = connectDesktop(server);
  await openProject(root);
  const trusted = await commands.projectTrustSet(root, true, false);
  if (trusted.status !== "ok") throw new Error(trusted.error.message);
  useProject.setState({ project: { ...useProject.getState().project!, trusted: true } });
  return root;
}

async function install(tool: string) {
  const tools = await call(commands.toolsList());
  if (tools.find((t) => t.name === tool)?.status === "installed") return;
  const channel = new Channel<InstallEvent>();
  const info = await call(commands.toolsInstall(tool, nextRequestId(), channel));
  expect(info.status, `${tool} installs`).toBe("installed");
}

/** What the Debug and Run tool windows show, for failure messages. */
function shown(): string {
  const { sessions, console } = useDebug.getState();
  const debug = Object.values(sessions).map(
    (s) =>
      `debug ${s.id} ${s.name} ${s.status} ${s.stopReason ?? ""}\n` +
      (console[s.id] ?? [])
        .slice(-40)
        .map((l) => `  ${l.text}`)
        .join(""),
  );
  const runs = useRun.getState().sessions.map((s) => `run ${s.id} ${s.config.name} ${s.status} ${s.exitCode ?? ""}`);
  const notes = useNotifications.getState().items.map((n) => `${n.level}: ${n.title} ${n.body ?? ""}`);
  return [...debug, ...runs, ...notes, `events: ${events.slice(-60).join(", ")}`, server?.log() ?? ""].join("\n");
}

/** Waits for `value` to be truthy; fails with what the tool windows show. */
async function until<T>(what: string, value: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = value();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${shown()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Requests `url` once the debugged server accepts connections (the response waits for Resume). */
async function requestWhenListening(url: string) {
  for (let i = 0; i < 600; i++) {
    const connected = await new Promise<boolean>((resolve) => {
      const req = get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("socket", (socket) => socket.on("connect", () => resolve(true)));
      req.on("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const paused = () => {
  const s = activeSession();
  return s?.status === "paused" && s.frames.length > 0 ? s : null;
};

/** Paused, failing as soon as every session has ended instead. */
const pausedOrEnded = () => {
  const sessions = Object.values(useDebug.getState().sessions);
  if (sessions.length > 0 && sessions.every((s) => s.status === "terminated"))
    throw new Error(`the debugger ended before the breakpoint\n${shown()}`);
  return paused();
};

async function smoke(language: string) {
  const c = CASES[language]!;
  const root = await open(c);
  await install(c.debugger);

  const path = join(root, c.file);
  const content = readFileSync(path, "utf8");
  const marker = content.split("\n").findIndex((l) => l.includes("Set a breakpoint here"));
  const line = marker + 1;
  addBreakpoint(path, line);

  await executeAction("run.debugContext", { path, content });
  if (c.request) void requestWhenListening(c.request);
  const s = await until("the breakpoint", pausedOrEnded, 5 * 60_000);
  expect(s.stopReason, `${s.stopDescription}\n${shown()}`).toBe("breakpoint");
  const top = s.frames[0]!;
  expect(top.path).toBe(path);
  expect(top.line).toBe(line);

  const scopes = await call(commands.debugScopes(s.id, top.id));
  const locals = await call(commands.debugVariables(s.id, scopes[0]!.variablesReference));
  expect(locals.map((v) => v.name)).toContain(c.variable);

  const value = await evaluate(c.evaluate[0], "repl", s);
  expect(value.value, c.evaluate[0]).toMatch(c.evaluate[1]);

  const stops = useDebug.getState().stopSeq;
  await executeAction("debug.stepOver");
  await until("Step Over", () => useDebug.getState().stopSeq > stops && paused());
  expect(paused()!.frames[0]!.line).toBeGreaterThan(line);

  await executeAction("debug.resume");
  if (c.request) {
    await until("the request to be served", () => useDebug.getState().sessions[s.id]?.status === "running");
    await executeAction("debug.stop");
  }
  await until("the end", () => useDebug.getState().sessions[s.id]?.status === "terminated");
}

for (const language of Object.keys(CASES)) {
  test(language, () => smoke(language));
}
