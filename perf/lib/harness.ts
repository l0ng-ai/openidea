/** Per-run handle passed to scenarios: page, CDP session and interaction helpers. */
import type { CDPSession, Page } from "@playwright/test";
import type { InPage } from "./inpage.ts";
import { median } from "./stats.ts";

export type Metrics = Record<string, number>;

export interface Scenario {
  id: string;
  title: string;
  /** Runner leaves the page blank (the scenario navigates itself), e.g. for start-up. */
  blank?: boolean;
  run(h: Harness): Promise<Metrics>;
}

type CdpCounters = Record<string, number>;

export class Harness {
  // Plain fields: Node's type stripping does not support parameter properties.
  readonly page: Page;
  readonly cdp: CDPSession;

  constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  /**
   * Loads the workbench; resolves with navigation → Project tree shown, once the
   * app has settled (the background prefetch of lazily loaded views is done), as
   * a user meets it a few seconds after start-up.
   */
  async load(): Promise<number> {
    await this.page.goto("/");
    await this.page.waitForFunction(() => "__openideaPerf" in window && "__perf" in window);
    const ready = await this.inPage((p) =>
      p.waitShown('[role="tree"][aria-label="Project"] [role="treeitem"]', null, 30_000),
    );
    await this.page.waitForLoadState("networkidle");
    return ready;
  }

  inPage<T, A = undefined>(fn: (p: InPage, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    return this.page.evaluate(
      // Re-created in the page from source: keep `fn` free of outer references.
      ({ src, arg }) =>
        new Function("p", "arg", `return (${src})(p, arg)`)((window as never as { __perf: InPage }).__perf, arg),
      { src: fn.toString(), arg: arg as A },
    ) as Promise<T>;
  }

  /** Effective keymap binding of an action, as Playwright key sequences ("Shift Shift" → two presses). */
  async keysFor(actionId: string): Promise<string[]> {
    const bindings = await this.page.evaluate(
      (id) => (window as never as { __openideaPerf: { bindings(id: string): string[] } }).__openideaPerf.bindings(id),
      actionId,
    );
    const binding = bindings[0];
    if (!binding) throw new Error(`action ${actionId} has no key binding`);
    return binding.split(" ").map((stroke) =>
      stroke
        .split("+")
        .map((k) => (k === "Ctrl" ? "Control" : k === "Cmd" ? "Meta" : k))
        .join("+"),
    );
  }

  async pressAction(actionId: string) {
    for (const k of await this.keysFor(actionId)) await this.page.keyboard.press(k);
  }

  /** Arms latency capture: the next input starts the clock, the paint showing `selector` stops it. */
  async measure(trigger: () => Promise<unknown>, selector: string, text: string | null = null, timeoutMs = 10_000) {
    await this.inPage((p) => p.arm());
    const done = this.inPage((p, a) => p.waitShown(a.selector, a.text, a.timeoutMs), { selector, text, timeoutMs });
    await trigger();
    return done;
  }

  /**
   * Types `text` one key at a time, `intervalMs` apart, recording keydown → next
   * frame for each key. `\n` presses Enter, `\b` Backspace.
   */
  async typeMeasured(text: string, intervalMs: number): Promise<number[]> {
    return this.pressMeasured(
      [...text].map((ch) => (ch === "\n" ? "Enter" : ch === "\b" ? "Backspace" : ch)),
      intervalMs,
    );
  }

  /** Presses `keys` `intervalMs` apart and returns keydown → next frame for each. */
  async pressMeasured(keys: string[], intervalMs: number): Promise<number[]> {
    await this.inPage((p) => {
      p.keyLatencies = [];
      p.recordKeys = true;
    });
    for (const key of keys) {
      const started = Date.now();
      await this.page.keyboard.press(key);
      const wait = intervalMs - (Date.now() - started);
      if (wait > 0) await this.page.waitForTimeout(wait);
    }
    // Let the last frames land.
    await this.inPage((p) => p.afterNextPaint().then(() => p.afterNextPaint()));
    return this.inPage((p) => {
      p.recordKeys = false;
      return p.keyLatencies;
    });
  }

  /** Display refresh interval measured over idle frames. */
  async refreshMs(): Promise<number> {
    await this.inPage((p) => p.startFrames());
    await this.page.waitForTimeout(400);
    return median(await this.inPage((p) => p.stopFrames()));
  }

  async counters(): Promise<CdpCounters> {
    const { metrics } = (await this.cdp.send("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>;
    };
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  /** Renderer work between two `counters()` snapshots. */
  static delta(before: CdpCounters, after: CdpCounters) {
    const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
    return {
      layouts: d("LayoutCount"),
      styleRecalcs: d("RecalcStyleCount"),
      styleLayoutMs: (d("LayoutDuration") + d("RecalcStyleDuration")) * 1000,
      scriptMs: d("ScriptDuration") * 1000,
      taskMs: d("TaskDuration") * 1000,
    };
  }

  async gc() {
    await this.cdp.send("HeapProfiler.collectGarbage");
    await this.cdp.send("HeapProfiler.collectGarbage");
  }

  async heapMb(): Promise<number> {
    const { usedSize } = (await this.cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    return usedSize / 2 ** 20;
  }

  async longTasksSince(t: number) {
    return this.inPage((p, since) => p.longTasks.filter((l) => l.start >= since), t);
  }

  now(): Promise<number> {
    return this.page.evaluate(() => performance.now());
  }

  /** Seeds a file into the in-memory backend without opening it. */
  async seed(path: string, text: string) {
    await this.page.evaluate(
      ({ path, text }) =>
        (window as never as { __openideaPerf: { seed(p: string, t: string): void } }).__openideaPerf.seed(path, text),
      { path, text },
    );
  }

  /** Seeds a file into the in-memory backend and opens it, returning open → painted ms. */
  async openFile(path: string, text?: string): Promise<number> {
    if (text !== undefined) await this.seed(path, text);
    const name = path.slice(path.lastIndexOf("/") + 1);
    return this.page.evaluate(
      async ({ path, name }) => {
        const w = window as never as { __perf: InPage; __openideaPerf: { openFile(p: string): Promise<void> } };
        const t0 = performance.now();
        void w.__openideaPerf.openFile(path);
        await w.__perf.waitShown('[role="tab"][aria-selected="true"]', name, 15_000);
        await w.__perf.waitShown(".cm-content .cm-line", null, 15_000);
        return performance.now() - t0;
      },
      { path, name },
    );
  }

  /** Waits until the active editor's background parse has caught up (steady-state editing). */
  async parserIdle(timeoutMs = 20_000) {
    await this.page.waitForFunction(
      () => !(window as never as { __openideaPerf: { parsing(): boolean } }).__openideaPerf.parsing(),
      undefined,
      { timeout: timeoutMs, polling: 100 },
    );
  }

  async setCursor(offset: number) {
    await this.page.evaluate(
      (o) => (window as never as { __openideaPerf: { setCursor(o: number): void } }).__openideaPerf.setCursor(o),
      offset,
    );
  }

  async editorState() {
    return this.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { editorState(): { length: number; lines: number; head: number } | null } }
      ).__openideaPerf.editorState(),
    );
  }
}
