/**
 * Native smoke (`pnpm smoke:native <app binary> [fixture]`): launches the built desktop app on a
 * copy of a fixture project and drives its real webview through the MCP bridge (debug builds only;
 * the build must have the global Tauri API: `--config src-tauri/tauri.dev.conf.json`). It checks
 * the boundary the browser E2E and `pnpm smoke` don't cross: a real IPC round trip, an open
 * buffer following a file another program changes on disk, an edit reaching the disk on save, and
 * an app that stays up through all of it.
 *
 * Needs a display (CI: `xvfb-run -a` on Linux). Writes `native-smoke.log` (the app's output) to
 * `OPENIDEA_SMOKE_LOG_DIR` when it is set.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BRIDGE_FIRST_PORT = 9223;
const BRIDGE_PORTS = 100;

const [appArg, fixtureArg = "ts-app"] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node smoke/native/run.ts <path to the debug app binary> [fixture]");
  process.exit(2);
}
const app = resolve(appArg);
const logDir = process.env.OPENIDEA_SMOKE_LOG_DIR;
if (logDir) mkdirSync(logDir, { recursive: true });
const logPath = join(logDir ?? tmpdir(), "native-smoke.log");

type Response = { id: string; success: boolean; data?: unknown; error?: string };

/** One connection to an app's bridge: `execute_js` and `invoke_tauri` as the MCP server sends them. */
class Bridge {
  private next = 0;
  private waiting = new Map<string, (r: Response) => void>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        const response = JSON.parse(String(event.data)) as Response;
        this.waiting.get(response.id)?.(response);
        this.waiting.delete(response.id);
      } catch {
        // Not a response (a broadcast event).
      }
    });
  }

  static connect(port: number, timeoutMs = 2000): Promise<Bridge | undefined> {
    return new Promise((resolveBridge) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const finish = (bridge?: Bridge) => {
        clearTimeout(timer);
        if (!bridge) socket.close();
        resolveBridge(bridge);
      };
      socket.addEventListener("error", () => finish(undefined));
      socket.addEventListener("open", () => finish(new Bridge(socket)));
    });
  }

  call(command: string, args: unknown, timeoutMs = 30_000): Promise<Response> {
    const id = `native-${++this.next}`;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`bridge: ${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, (response) => {
        clearTimeout(timer);
        resolveCall(response);
      });
      this.socket.send(JSON.stringify({ id, command, args }));
    });
  }

  /** Runs `body` (an async function body that returns JSON) in the app's window. */
  async js<T>(body: string): Promise<T> {
    const response = await this.call("execute_js", { script: `return (async () => { ${body} })()` });
    if (!response.success) throw new Error(`in the window: ${response.error ?? "unknown error"}`);
    return response.data as T;
  }

  /** An IPC command of the app, as the frontend calls it. */
  invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.js<T>(
      `return await window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});`,
    );
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const found = await probe();
      if (found) return found;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline)
      throw new Error(`${what}: timed out after ${timeoutMs} ms${last ? `; last error: ${last}` : ""}`);
    await sleep(500);
  }
}

async function liveBridgePorts(): Promise<number[]> {
  const ports = Array.from({ length: BRIDGE_PORTS }, (_, i) => BRIDGE_FIRST_PORT + i);
  const found = await Promise.all(
    ports.map(async (port) => {
      const bridge = await Bridge.connect(port, 800);
      bridge?.close();
      return bridge ? port : undefined;
    }),
  );
  return found.filter((p): p is number => p !== undefined);
}

type DocumentInfo = { id: number; path: string; text: string; version: number; dirty: boolean };

const results: { step: string; ms: number; error?: string }[] = [];
let child: ChildProcess | undefined;
let bridge: Bridge | undefined;
let project = "";

async function step(name: string, run: () => Promise<void>) {
  const started = Date.now();
  try {
    await run();
    results.push({ step: name, ms: Date.now() - started });
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ step: name, ms: Date.now() - started, error });
    console.error(`FAIL  ${name}: ${error}`);
    throw e;
  }
}

function stopApp() {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  if (!existsSync(app)) throw new Error(`no app binary at ${app}`);
  const fixture = resolve(import.meta.dirname, "../../fixtures", fixtureArg);
  project = mkdtempSync(join(tmpdir(), "openidea-native-"));
  cpSync(fixture, join(project, fixtureArg), { recursive: true, filter: (src) => !/node_modules/.test(src) });
  const root = join(project, fixtureArg);
  const file = join(root, "src", "index.ts");
  const original = readFileSync(file, "utf8");

  const before = new Set(await liveBridgePorts());
  const out = openSync(logPath, "w");
  child = spawn(app, [root], { stdio: ["ignore", out, out], env: process.env });
  let exited: string | undefined;
  child.once("exit", (code, signal) => (exited = `exit code ${code}, signal ${signal}`));

  await step("the app starts and its bridge answers", async () => {
    const port = await until("the app's bridge", 180_000, async () => {
      if (exited) throw new Error(`the app exited at start: ${exited}`);
      return (await liveBridgePorts()).find((p) => !before.has(p));
    });
    bridge = await until("a bridge connection", 30_000, () => Bridge.connect(port));
  });
  const b = () => bridge!;

  await step("the window has the Tauri runtime", async () => {
    await until("the Tauri runtime in the window", 120_000, async () =>
      b().js<boolean>("return Boolean(window.__TAURI__ && window.__TAURI__.core);"),
    );
  });

  await step("an IPC round trip returns the language servers", async () => {
    const servers = await until("lsp_servers", 120_000, async () => b().invoke<unknown[]>("lsp_servers"));
    if (!Array.isArray(servers)) throw new Error(`lsp_servers returned ${JSON.stringify(servers)}`);
  });

  let doc!: DocumentInfo;
  await step("a file opens with its text from disk", async () => {
    doc = await until("doc_open", 60_000, async () => b().invoke<DocumentInfo>("doc_open", { path: file }));
    if (doc.text.replace(/\r\n/g, "\n") !== original.replace(/\r\n/g, "\n"))
      throw new Error("the opened text differs from the file");
  });

  const marker = "// changed by another program";
  await step("an open buffer follows a change on disk", async () => {
    writeFileSync(file, `${original}\n${marker}\n`);
    await until("the buffer to follow the file", 60_000, async () => {
      const now = await b().invoke<DocumentInfo>("doc_snapshot", { doc: doc.id });
      return now.text.includes(marker) && !now.dirty;
    });
  });

  const edit = "// typed in the editor";
  await step("an edit in the app reaches the disk on save", async () => {
    const now = await b().invoke<DocumentInfo>("doc_snapshot", { doc: doc.id });
    const at = now.text.length;
    await b().invoke("doc_edit", {
      doc: doc.id,
      baseVersion: now.version,
      changes: { changes: [{ from: at, to: at, insert: `\n${edit}\n` }] },
    });
    await b().invoke("doc_save", { doc: doc.id });
    await until("the saved file", 30_000, async () => readFileSync(file, "utf8").includes(edit));
  });

  await step("the app is still running after all of it", async () => {
    if (exited) throw new Error(`the app exited: ${exited}`);
    await b().invoke("lsp_servers");
  });
}

let failure: unknown;
try {
  await main();
} catch (e) {
  failure = e;
} finally {
  bridge?.close();
  stopApp();
  const summary = [
    "| step | result | ms |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.step} | ${r.error ? `FAIL: ${r.error.replace(/\|/g, "/")}` : "ok"} | ${r.ms} |`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Native smoke\n\n${summary}\n`);
  if (failure) {
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").slice(-40).join("\n") : "(no app log)";
    console.error(`\nend of the app's output (${logPath}):\n${tail}`);
  }
  if (project) rmSync(project, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
