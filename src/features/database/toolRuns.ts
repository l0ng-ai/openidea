/** Runs of `pg_dump` / `pg_restore` / `psql`: they outlive the dialog that started them. */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DbTool,
  type DbToolJob,
  type DbToolLine,
  type RequestId,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { canRevealInFileManager, revealInFileManager, revealInFileManagerLabel } from "@/platform/fileManager";
import { notifications } from "@/workbench/contributions";
import { baseName, formatElapsed } from "./dumpTools";
import { log, targetLabel, withConnection } from "./store";

const MAX_LINES = 5000;

export const TOOL_PROGRAMS: Record<DbTool, string> = {
  pgDump: "pg_dump",
  pgRestore: "pg_restore",
  psql: "psql",
};

export interface ToolRun {
  key: number;
  tool: DbTool;
  target: string;
  lines: DbToolLine[];
  status: "running" | "done" | "failed" | "cancelled";
  /** The process's exit code, or why it did not start. */
  exit: number | null;
  error?: string;
  /** What moves where, e.g. `shop → shop-2026-03-07.sql` (file names shortened). */
  route: string;
  startedAt: number;
  endedAt?: number;
}

export const useToolRuns = create<{ runs: Record<number, ToolRun> }>(() => ({ runs: {} }));

let nextKey = 1;
const requests = new Map<number, RequestId>();

function update(key: number, change: (r: ToolRun) => Partial<ToolRun>) {
  useToolRuns.setState((s) => {
    const r = s.runs[key];
    return r ? { runs: { ...s.runs, [key]: { ...r, ...change(r) } } } : s;
  });
}

export interface ToolRunRequest {
  target: string;
  executable: string;
  job: DbToolJob;
  /** Shown in the Output tab. */
  commandLine: string;
  /** The file or directory a dump writes, offered in the finish notification. */
  output?: string;
  /** Shown as `from → to`; paths are shortened to their file name. */
  from: string;
  to: string;
  onSuccess?: () => void;
}

/** Starts the tool (asking for the password first when needed) and returns its run's key. */
export function startToolRun(req: ToolRunRequest): number {
  const key = nextKey++;
  const run: ToolRun = {
    key,
    tool: req.job.tool,
    target: req.target,
    lines: [],
    status: "running",
    exit: null,
    route: `${shorten(req.from)} → ${shorten(req.to)}`,
    startedAt: Date.now(),
  };
  useToolRuns.setState((s) => ({ runs: { ...s.runs, [key]: run } }));
  log("statement", req.commandLine);
  void execute(key, req);
  return key;
}

async function execute(key: number, req: ToolRunRequest) {
  const label = targetLabel(req.target);
  const program = TOOL_PROGRAMS[req.job.tool];
  try {
    const exit = await withConnection(req.target, () => {
      const request = nextRequestId();
      requests.set(key, request);
      const channel = new Channel<DbToolLine[]>();
      channel.onmessage = (batch) =>
        update(key, (r) => {
          const lines = r.lines.concat(batch);
          return { lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
        });
      return call(commands.dbRunTool(request, req.target, req.executable, req.job, channel));
    });
    const ok = exit === 0;
    const took = finish(key, { status: ok ? "done" : "failed", exit });
    const route = routeOf(key);
    log(ok ? "result" : "error", tx`${program} finished with exit code ${String(exit ?? "?")} in ${took}`);
    if (ok) req.onSuccess?.();
    const reveal =
      ok && req.output && canRevealInFileManager()
        ? [{ label: revealInFileManagerLabel(), run: () => void revealInFileManager(req.output!) }]
        : [];
    notifications().notify({
      level: ok ? "info" : "error",
      title: ok ? tx`${program} finished: ${label}` : tx`${program} failed: ${label}`,
      body: ok
        ? tx`${route} in ${took}`
        : errorTail(key) ||
          tx`Exit code ${String(exit ?? "?")}. The Database tool window's Output tab has the command.`,
      actions: reveal,
      key: `db-tool-${key}`,
    });
  } catch (e) {
    if (isCancelled(e)) {
      const took = finish(key, { status: "cancelled" });
      log("info", tx`${program} stopped after ${took}`);
      return;
    }
    const error = e instanceof Error ? e.message : String(e);
    finish(key, { status: "failed", error });
    log("error", error);
    notifications().notify({ level: "error", title: tx`Cannot run ${program}`, body: error, key: `db-tool-${key}` });
  } finally {
    requests.delete(key);
  }
}

/** Records the end of run `key` and returns how long it took. */
function finish(key: number, change: Partial<ToolRun>): string {
  const endedAt = Date.now();
  update(key, () => ({ ...change, endedAt }));
  return formatElapsed(endedAt - (useToolRuns.getState().runs[key]?.startedAt ?? endedAt));
}

const routeOf = (key: number) => useToolRuns.getState().runs[key]?.route ?? "";

const shorten = (s: string) => (/[\\/]/.test(s) ? baseName(s) : s);

/** The last lines the tool wrote to stderr, where it reports what went wrong. */
function errorTail(key: number): string {
  const lines = useToolRuns.getState().runs[key]?.lines ?? [];
  return lines
    .filter((l) => l.stderr)
    .slice(-3)
    .map((l) => l.text)
    .join("\n");
}

export function stopToolRun(key: number) {
  const request = requests.get(key);
  if (request) void commands.cancelRequest(request);
}
