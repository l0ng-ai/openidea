import type { TerminalId, TerminalInfo, WebPtyCommand } from "@/bindings";
import { tx } from "@/platform/i18n";

const MAX_SESSIONS = 8;
const MAX_INPUT = 64 << 10;
const MAX_OUTPUT = 256 << 10;
const MAX_MESSAGE = 2 << 20;
const counts = new Map<string, number>();

export interface PtyBackend {
  spawn(command: WebPtyCommand, output: (data: string) => void): Promise<TerminalInfo>;
  write(id: TerminalId, data: string): Promise<unknown>;
  resize(id: TerminalId, cols: number, rows: number): Promise<unknown>;
  kill(id: TerminalId): Promise<unknown>;
  onExit(listener: (id: TerminalId, code: number | null) => void): () => void;
}

interface Session {
  id?: TerminalId;
  stopped: boolean;
  release(): void;
  inputs: string[];
  inputSize: number;
  writing: boolean;
  size?: [number, number];
  resizing: boolean;
  output: string[];
  outputSize: number;
  awaiting?: number;
  sentSize?: number;
  sequence: number;
  exit?: { code: number | null };
}

function dimensions(cols: unknown, rows: unknown): cols is number {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    Number(cols) >= 2 &&
    Number(cols) <= 500 &&
    Number(rows) >= 1 &&
    Number(rows) <= 500
  );
}

/** One frame or log tab owns this bridge. Terminal ids never cross the frame boundary. */
export function ptyBridge(pluginId: string, backend: PtyBackend, send: (message: object) => void) {
  const sessions = new Map<string, Session>();
  const earlyExits = new Map<TerminalId, number | null>();
  let closed = false;
  const error = (sessionId: string, message: string) => send({ op: "pty-error", sessionId, error: message });
  const stop = (sid: string, entry: Session) => {
    if (entry.stopped) return;
    entry.stopped = true;
    if (sessions.get(sid) === entry) sessions.delete(sid);
    entry.inputs = [];
    entry.output = [];
    if (entry.id !== undefined)
      void backend
        .kill(entry.id)
        .catch(() => {})
        .finally(entry.release);
    // A pending spawn keeps its slot until its returned terminal is killed.
  };
  const flush = (sid: string, entry: Session) => {
    if (closed || entry.stopped || entry.awaiting !== undefined) return;
    const data = entry.output.shift();
    if (data !== undefined) {
      entry.sentSize = data.length;
      entry.awaiting = ++entry.sequence;
      send({ op: "pty-data", sessionId: sid, data, sequence: entry.awaiting });
    } else if (entry.exit) {
      send({ op: "pty-exit", sessionId: sid, exitCode: entry.exit.code });
      entry.stopped = true;
      sessions.delete(sid);
      entry.release();
    }
  };
  const exited = (id: TerminalId, code: number | null) => {
    const found = [...sessions].find(([, e]) => e.id === id);
    if (found) {
      const [sid, entry] = found;
      entry.exit = { code };
      flush(sid, entry);
    } else if ([...sessions.values()].some((e) => e.id === undefined) && earlyExits.size < 32) {
      earlyExits.set(id, code);
    }
  };
  const off = backend.onExit(exited);
  const write = async (sid: string, entry: Session) => {
    if (entry.writing || entry.id === undefined) return;
    entry.writing = true;
    try {
      while (!entry.stopped && entry.inputs.length) {
        const data = entry.inputs.shift()!;
        await backend.write(entry.id, data);
        entry.inputSize -= data.length;
      }
    } catch {
      if (!entry.stopped) error(sid, tx("Cannot write to PTY"));
      stop(sid, entry);
    } finally {
      entry.writing = false;
    }
  };
  const resize = async (sid: string, entry: Session) => {
    if (entry.resizing || entry.id === undefined) return;
    entry.resizing = true;
    try {
      while (!entry.stopped && entry.size) {
        const [cols, rows] = entry.size;
        entry.size = undefined;
        await backend.resize(entry.id, cols, rows);
      }
    } catch {
      if (!entry.stopped) error(sid, tx("Cannot resize PTY"));
      stop(sid, entry);
    } finally {
      entry.resizing = false;
    }
  };
  return {
    handle(text: string): boolean {
      let m: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        m = value as Record<string, unknown>;
      } catch {
        return false;
      }
      if (typeof m.op !== "string" || !m.op.startsWith("pty-")) return false;
      if (closed) return true;
      const sid = typeof m.sessionId === "string" ? m.sessionId : "";
      if (text.length > MAX_MESSAGE || !/^[\w.-]{1,64}$/.test(sid)) {
        error("", tx("Invalid PTY request"));
        return true;
      }
      const invalid = () => error(sid, tx("Invalid PTY request"));
      const entry = sessions.get(sid);
      switch (m.op) {
        case "pty-spawn": {
          const { program, args = [], env = {}, cols = 100, rows = 28 } = m;
          if (
            entry ||
            typeof program !== "string" ||
            !program ||
            program.length > 256 ||
            program.trim() !== program ||
            /[\0\r\n]/.test(program) ||
            !Array.isArray(args) ||
            args.length > 256 ||
            args.some((a) => typeof a !== "string" || a.length > 4096 || a.includes("\0")) ||
            !env ||
            typeof env !== "object" ||
            Array.isArray(env) ||
            Object.keys(env).length > 64 ||
            Object.entries(env).some(
              ([k, v]) =>
                !k || k.length > 256 || /[=\0]/.test(k) || typeof v !== "string" || v.length > 4096 || v.includes("\0"),
            ) ||
            !dimensions(cols, rows) ||
            "cwd" in m
          ) {
            invalid();
            return true;
          }
          const count = counts.get(pluginId) ?? 0;
          if (count >= MAX_SESSIONS) {
            error(sid, tx("Too many PTY sessions"));
            return true;
          }
          counts.set(pluginId, count + 1);
          let released = false;
          const created: Session = {
            stopped: false,
            inputs: [],
            inputSize: 0,
            writing: false,
            resizing: false,
            output: [],
            outputSize: 0,
            sequence: 0,
            release() {
              if (released) return;
              released = true;
              const left = (counts.get(pluginId) ?? 1) - 1;
              if (left) counts.set(pluginId, left);
              else counts.delete(pluginId);
            },
          };
          sessions.set(sid, created);
          void backend
            .spawn(
              { program, args: args as string[], env: env as Record<string, string>, cols, rows: Number(rows) },
              (data) => {
                if (closed || created.stopped || !data) return;
                created.outputSize += data.length;
                if (created.outputSize > MAX_OUTPUT) {
                  error(sid, tx("PTY output limit exceeded"));
                  stop(sid, created);
                  return;
                }
                created.output.push(data);
                flush(sid, created);
              },
            )
            .then(
              (info) => {
                created.id = info.id;
                if (closed || created.stopped) {
                  void backend
                    .kill(info.id)
                    .catch(() => {})
                    .finally(created.release);
                  return;
                }
                if (earlyExits.has(info.id)) {
                  created.exit = { code: earlyExits.get(info.id)! };
                  earlyExits.delete(info.id);
                  flush(sid, created);
                } else {
                  void write(sid, created);
                  void resize(sid, created);
                }
                if (![...sessions.values()].some((e) => e.id === undefined)) earlyExits.clear();
              },
              (err: unknown) => {
                if (!closed && !created.stopped) error(sid, String(err));
                created.release();
                stop(sid, created);
              },
            );
          return true;
        }
        case "pty-input":
          if (typeof m.data !== "string" || m.data.length > MAX_INPUT) {
            invalid();
            break;
          }
          if (entry && !entry.exit && m.data.length) {
            entry.inputSize += m.data.length;
            if (entry.inputSize > MAX_INPUT) {
              error(sid, tx("PTY input limit exceeded"));
              stop(sid, entry);
              break;
            }
            entry.inputs.push(m.data);
            void write(sid, entry);
          }
          break;
        case "pty-resize":
          if (!dimensions(m.cols, m.rows)) {
            invalid();
            break;
          }
          if (entry && !entry.exit) {
            entry.size = [Number(m.cols), Number(m.rows)];
            void resize(sid, entry);
          }
          break;
        case "pty-kill":
          if (entry) stop(sid, entry);
          break;
        case "pty-ack":
          if (entry && Number.isSafeInteger(m.sequence) && m.sequence === entry.awaiting) {
            // The in-flight chunk counts against the same bound as the unsent queue.
            entry.outputSize -= entry.sentSize ?? 0;
            entry.awaiting = undefined;
            flush(sid, entry);
          }
          break;
        default:
          invalid();
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      off();
      for (const [sid, entry] of sessions) stop(sid, entry);
      earlyExits.clear();
    },
  };
}
