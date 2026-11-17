/**
 * One eval session: a release `openidea-server --stdio` with its own home, and the production
 * workbench in Chromium connected to it as remote development connects a window (the Tauri
 * runtime from `smoke/tauriShim.ts`, commands and notifications relayed by Playwright).
 */
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { installInPage } from "../../perf/lib/inpage.ts";
import { Server } from "../../smoke/server.ts";
import { copyProject } from "./projects.ts";
import { installTauriShim, type ShimWindow } from "../../smoke/tauriShim.ts";

/** How long after its answer Show Usages invoked again widens it (`HINT_MS` in code-insight/usages.ts), plus a margin. */
const SHOW_USAGES_HINT_MS = 4200;

export interface IpcCall {
  cmd: string;
  /** Milliseconds since the session started. */
  start: number;
  ms: number;
  ok: boolean;
  /** JSON length of the result (or error). */
  bytes: number;
  /** Array length of the result, when it is one. */
  items?: number;
  /** Still unanswered when the window closed (`ms` is how long it had waited). */
  pending?: true;
}

export interface TaskSpan {
  id: number;
  title: string;
  start: number;
  end: number | null;
}

/** What the server did, for diagnostics: every command, background task and server status. */
export class Timeline {
  readonly t0 = Date.now();
  readonly calls: IpcCall[] = [];
  readonly tasks = new Map<number, TaskSpan>();
  readonly servers: Array<{ at: number; name: string; status: string; message: string | null }> = [];
  /** Last time anything happened (a call ended, a task or status changed). */
  lastActivity = 0;
  inFlight = 0;
  /** When the scenario's measured step started, for a failure's window. */
  stepStart: number | null = null;
  /** Commands sent and not answered yet, by call number. */
  readonly unanswered = new Map<number, { cmd: string; start: number }>();
  private nextCall = 0;

  now() {
    return Date.now() - this.t0;
  }

  onEvent(event: { type: string } & Record<string, unknown>) {
    if (event.type === "task") {
      const id = event.id as number;
      const span = this.tasks.get(id) ?? { id, title: String(event.title), start: this.now(), end: null };
      if (event.done) span.end = this.now();
      this.tasks.set(id, span);
      this.lastActivity = this.now();
    } else if (event.type === "languageServer") {
      this.servers.push({
        at: this.now(),
        name: String(event.name),
        status: String(event.status),
        message: (event.message as string | null) ?? null,
      });
      this.lastActivity = this.now();
    }
  }

  /** Records `cmd` as sent; the returned function marks it answered. */
  sent(cmd: string, start: number): () => void {
    const id = this.nextCall++;
    this.unanswered.set(id, { cmd, start });
    return () => this.unanswered.delete(id);
  }

  runningTasks(): TaskSpan[] {
    return [...this.tasks.values()].filter((t) => t.end === null);
  }

  serverStatus(name: string): string | null {
    for (let i = this.servers.length - 1; i >= 0; i--)
      if (this.servers[i]!.name === name) return this.servers[i]!.status;
    return null;
  }

  /** The calls and tasks overlapping `[from, to]` (session milliseconds). */
  window(from: number, to: number) {
    return {
      calls: [
        ...this.calls.filter((c) => c.start <= to && c.start + c.ms >= from),
        // A command that never answers is what a timeout usually waits on.
        ...[...this.unanswered.values()]
          .filter((c) => c.start <= to)
          .map((c): IpcCall => ({ ...c, ms: this.now() - c.start, ok: false, bytes: 0, pending: true })),
      ],
      tasks: [...this.tasks.values()].filter((t) => t.start <= to && (t.end ?? Infinity) >= from),
    };
  }
}

export interface SessionOptions {
  /** `fixtures/<name>` or a project pinned in `evals/projects.json`. */
  fixture: string;
  /** Where the project copy and the server's home go. */
  workDir: string;
  /** Keep the server's home (installed tools, language server workspaces) from an earlier session. */
  keepHome: boolean;
  /** `OPENIDEA_LOG` for the server. */
  log?: string;
}

export class Session {
  readonly timeline = new Timeline();
  readonly root: string;
  readonly home: string;
  page!: Page;
  private context!: BrowserContext;
  private server!: Server;
  private relayQueue: Promise<unknown> = Promise.resolve();
  private pendingNotes: Array<[kind: "channel" | "event", a: unknown, b: unknown]> = [];
  /** The last answer to each command that succeeded, for what the UI only summarises. */
  readonly lastAnswer = new Map<string, unknown>();
  /** Editors changed by a scenario: path → the text to put back. */
  private readonly edited = new Map<string, string>();
  readonly pageErrors: string[] = [];

  private constructor(opts: SessionOptions) {
    this.root = join(opts.workDir, "projects", opts.fixture);
    this.home = join(opts.workDir, "home");
  }

  static async start(browser: Browser, url: string, repoRoot: string, opts: SessionOptions): Promise<Session> {
    const s = new Session(opts);
    copyProject(repoRoot, opts.fixture, s.root);
    if (!opts.keepHome) rmSync(s.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    mkdirSync(s.home, { recursive: true });

    s.server = await Server.start(s.home, opts.log ? { OPENIDEA_LOG: opts.log } : {});
    s.server.onEvent = (target, event) => {
      if (target !== null && target !== "main") return;
      s.timeline.onEvent(event as { type: string });
      s.notify("event", target, event);
    };
    s.server.onChannel = (id, data) => s.notify("channel", id, data);
    await s.server.invoke("project_trust_set", { path: s.root, trusted: true, folder: false });

    s.context = await browser.newContext({
      baseURL: url,
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await s.context.exposeFunction("__openideaRelay", async (cmd: string, args: unknown) => {
      const start = s.timeline.now();
      s.timeline.inFlight++;
      const answered = s.timeline.sent(cmd, start);
      try {
        const value = await s.server.invoke(cmd, args);
        s.record(cmd, start, true, value);
        return { ok: value ?? null };
      } catch (err) {
        s.record(cmd, start, false, err);
        return { err };
      } finally {
        answered();
        s.timeline.inFlight--;
        s.timeline.lastActivity = s.timeline.now();
      }
    });
    await s.context.addInitScript(installTauriShim, {
      directories: { 12: tmpdir(), 21: homedir() },
      sep: sep as "/" | "\\",
    });
    await s.context.addInitScript(() => {
      const w = window as unknown as ShimWindow & {
        __openideaRelay(cmd: string, args: unknown): Promise<{ ok: unknown } | { err: unknown }>;
      };
      w.__openideaForward = async (cmd, args) => {
        const r = await w.__openideaRelay(cmd, args);
        if ("err" in r) throw r.err;
        return r.ok;
      };
    });
    await s.context.addInitScript(installInPage);
    s.page = await s.context.newPage();
    s.page.on("pageerror", (e) => s.pageErrors.push(e.message));
    if (process.env.OPENIDEA_EVAL_DEBUG) {
      s.page.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 300)));
      s.page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    }

    await s.page.goto("/");
    await s.page.waitForFunction(() => "__openideaPerf" in window && "__openideaShim" in window);
    await s.page.evaluate(
      (root) =>
        (window as unknown as { __openideaPerf: { openProject(p: string): Promise<void> } }).__openideaPerf.openProject(
          root,
        ),
      s.root,
    );
    await s.page.waitForSelector('[role="tree"][aria-label="Project"] [role="treeitem"]', { timeout: 60_000 });
    return s;
  }

  private record(cmd: string, start: number, ok: boolean, value: unknown) {
    let bytes = 0;
    try {
      bytes = JSON.stringify(value ?? null).length;
    } catch {
      // not serialisable: size unknown
    }
    const items = Array.isArray(value)
      ? value.length
      : value && typeof value === "object" && Array.isArray((value as { locations?: unknown }).locations)
        ? (value as { locations: unknown[] }).locations.length
        : undefined;
    this.timeline.calls.push({ cmd, start, ms: this.timeline.now() - start, ok, bytes, items });
    if (ok) this.lastAnswer.set(cmd, value);
  }

  /** Delivers server notifications in order, batched per turn of the event loop. */
  private notify(kind: "channel" | "event", a: unknown, b: unknown) {
    this.pendingNotes.push([kind, a, b]);
    if (this.pendingNotes.length > 1) return;
    this.relayQueue = this.relayQueue
      .then(() => new Promise((r) => setImmediate(r)))
      .then(() => {
        const batch = this.pendingNotes;
        this.pendingNotes = [];
        return this.page
          ?.evaluate((notes) => {
            const shim = (window as unknown as ShimWindow).__openideaShim;
            for (const [kind, a, b] of notes) {
              if (kind === "channel") shim.channel(a as number, b);
              else shim.event(a as string | null, b);
            }
          }, batch)
          .catch(() => {});
      });
  }

  runAction(id: string, arg?: unknown): Promise<boolean> {
    return this.page.evaluate(
      async ({ id, arg }) => {
        const w = window as unknown as {
          __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> };
          __openideaEvalShowUsagesAt?: number;
        };
        const ran = await w.__openideaPerf.runAction(id, arg);
        if (id === "find.showUsages") w.__openideaEvalShowUsagesAt = performance.now();
        return ran;
      },
      { id, arg },
    );
  }

  /** Opens `rel` (project-relative, or a URI) in an editor and waits until its text is shown. */
  async openFile(rel: string) {
    const path = /^[a-z]+:\/\//.test(rel) ? rel : join(this.root, rel);
    const bare = rel.replace(/[?#].*$/, "");
    const name = bare.slice(bare.lastIndexOf("/") + 1);
    await this.page.evaluate(
      async ({ path, name }) => {
        const w = window as unknown as {
          __perf: { waitShown(s: string, t: string | null, ms: number): Promise<number> };
          __openideaPerf: { openFile(p: string): Promise<void> };
        };
        await w.__openideaPerf.openFile(path);
        await w.__perf.waitShown('[role="tab"][aria-selected="true"]', name, 30_000);
        await w.__perf.waitShown(".cm-content .cm-line", null, 30_000);
      },
      { path, name },
    );
  }

  /**
   * Goes to the declaration of `word` on `line` of the active editor and waits until another
   * file shows (a library class: its `jdt://` URI, which carries what only the server knows).
   */
  async declarationOf(line: string, word: string): Promise<string> {
    await this.caretAt(line, word);
    type Probe = { __openideaPerf: { editorState(): { path: string } | null } };
    const from = await this.page.evaluate(() => (window as unknown as Probe).__openideaPerf.editorState()?.path);
    await this.runAction("navigate.declaration");
    const handle = await this.page.waitForFunction(
      (from) => {
        const path = (window as unknown as Probe).__openideaPerf.editorState()?.path;
        return path && path !== from && document.querySelector(".cm-content .cm-line") ? path : null;
      },
      from,
      { timeout: 30_000 },
    );
    return (await handle.jsonValue()) as string;
  }

  /** Puts the caret inside `word` on the active editor's first line containing `line` (both literal). */
  async caretAt(line: string, word: string) {
    const text = await this.editorText();
    const at = text.indexOf(line);
    if (at < 0) throw new Error(`no line containing ${JSON.stringify(line)} in the active editor`);
    const inLine = line.indexOf(word);
    if (inLine < 0) throw new Error(`${JSON.stringify(word)} is not in ${JSON.stringify(line)}`);
    // Inside the word, as a click on it would put it.
    const target = at + inLine + Math.floor(word.length / 2);
    await this.page.evaluate(
      (o) => (window as unknown as { __openideaPerf: { setCursor(o: number): void } }).__openideaPerf.setCursor(o),
      target,
    );
  }

  /** The active editor's whole text. */
  editorText(): Promise<string> {
    return this.page.evaluate(() => {
      const text = (
        window as unknown as { __openideaPerf: { editorText(): string | null } }
      ).__openideaPerf.editorText();
      if (text === null) throw new Error("no active editor");
      return text;
    });
  }

  /** Keeps the active editor's text, for `reset` to put back whatever the scenario changes. */
  async keepText() {
    const { path, text } = await this.page.evaluate(() => {
      const probe = (
        window as unknown as {
          __openideaPerf: { editorState(): { path: string } | null; editorText(): string | null };
        }
      ).__openideaPerf;
      return { path: probe.editorState()?.path, text: probe.editorText() };
    });
    if (path === undefined || text === null) throw new Error("no active editor");
    if (!this.edited.has(path)) this.edited.set(path, text);
  }

  /** Inserts `text` after the first `after` in the active editor; the offset after it. */
  async edit(after: string, text: string): Promise<number> {
    await this.keepText();
    return this.page.evaluate(
      ({ after, text }) =>
        (
          window as unknown as { __openideaPerf: { insertAfter(a: string, t: string): number } }
        ).__openideaPerf.insertAfter(after, text),
      { after, text },
    );
  }

  private async restoreEdits() {
    for (const [path, text] of this.edited) {
      await this.page.evaluate(
        async ({ path, text }) => {
          const probe = (
            window as unknown as {
              __openideaPerf: {
                openFile(p: string): Promise<void>;
                editorState(): { path: string } | null;
                editorText(): string | null;
                setText(t: string): void;
              };
            }
          ).__openideaPerf;
          await probe.openFile(path);
          while (probe.editorState()?.path !== path) await new Promise(requestAnimationFrame);
          if (probe.editorText() !== text) probe.setText(text);
        },
        { path, text },
      );
      await this.runAction("file.save");
    }
    this.edited.clear();
  }

  /** Waits until `server` is ready and nothing has happened for `quietMs`: no task, no command in flight. */
  async settle(server: string, quietMs = 2000, timeoutMs = 5 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = this.timeline;
      const quiet =
        t.serverStatus(server) === "ready" &&
        t.runningTasks().length === 0 &&
        t.inFlight === 0 &&
        t.now() - t.lastActivity >= quietMs;
      if (quiet) return;
      if (Date.now() > deadline) {
        throw new Error(
          `the IDE did not settle within ${timeoutMs / 1000}s: ${server} ${t.serverStatus(server) ?? "not started"}, ` +
            `tasks ${JSON.stringify(t.runningTasks().map((x) => x.title))}, ${t.inFlight} command(s) in flight`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Back to an idle workbench: popups dismissed, edits undone, every editor closed. */
  async reset() {
    // Show Usages invoked again within 4 s of its hint widens the previous search: wait it out.
    const since = await this.page.evaluate(() => {
      const at = (window as unknown as { __openideaEvalShowUsagesAt?: number }).__openideaEvalShowUsagesAt;
      return at === undefined ? Infinity : performance.now() - at;
    });
    if (since < SHOW_USAGES_HINT_MS) await this.page.waitForTimeout(SHOW_USAGES_HINT_MS - since);
    await this.page.keyboard.press("Escape");
    await this.page.keyboard.press("Escape");
    await this.restoreEdits();
    await this.runAction("editor.closeAllTabs");
    await this.page.waitForFunction(() => !document.querySelector('[role="tab"][aria-selected="true"]'), undefined, {
      timeout: 10_000,
    });
  }

  serverLog(): string {
    return this.server.log();
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.server?.close();
  }
}
