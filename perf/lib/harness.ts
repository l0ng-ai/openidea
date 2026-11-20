/** Per-run handle passed to scenarios: page, CDP session and interaction helpers. */
import type { CDPSession, Page } from "@playwright/test";
import type { InPage } from "./inpage.ts";
import { median } from "./stats.ts";
import { assertTypedKey, openFileMeasured, readEditable, type EditableRange, type EditorProbe } from "./editing.ts";

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

  /** Measures a current input and a changed, matching target at frame start. */
  async measure<A = undefined>(
    trigger: () => Promise<unknown>,
    selector: string,
    text: string | null = null,
    timeoutMs = 10_000,
    check?: (arg: A) => boolean,
    arg?: A,
  ) {
    const token = await this.inPage((p) => p.arm());
    // Attach both handlers immediately: a failed trigger must not strand a rejecting page evaluation.
    const done = this.inPage(
      (p, a) => {
        const condition = a.check ? new Function("arg", `return (${a.check})(arg)`) : null;
        return p.waitShown(a.selector, a.text, a.timeoutMs, a.token, condition ? () => condition(a.arg) : undefined);
      },
      { selector, text, timeoutMs, token, check: check?.toString(), arg },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      if ((await trigger()) === false) throw new Error("measurement trigger returned false");
      const result = await done;
      if (!result.ok) throw result.error;
      return result.value;
    } finally {
      await this.inPage((p, token) => p.cancel(token), token);
    }
  }

  /**
   * Types `text` one key at a time, `intervalMs` apart, recording keydown → next
   * frame for each key. `\n` presses Enter, `\b` Backspace.
   */
  async typeMeasured(text: string, intervalMs: number, target: "editor" | "input" = "editor"): Promise<number[]> {
    const initial = await this.page.evaluate(readEditable, undefined);
    if (initial.kind !== target) throw new Error(`typing focus is not in the expected ${target}`);
    const characters = [...text];
    let range: EditableRange | undefined;
    let before = initial;
    if (initial.kind === "editor") {
      let from = initial.text.lastIndexOf("\n", initial.head - 1) + 1;
      // A Backspace can cross at most one existing line; indentation deletion stays within it.
      for (const character of characters) {
        if (character === "\b" && from > 0) from = initial.text.lastIndexOf("\n", from - 2) + 1;
      }
      const nextLine = initial.text.indexOf("\n", Math.min(initial.text.length, initial.head + characters.length + 1));
      const to = nextLine < 0 ? initial.text.length : nextLine + 1;
      range = { from, to, length: initial.text.length };
      const head = initial.head - from;
      before = { ...initial, text: initial.text.slice(from, to), head, from: head, to: head };
    }
    const latencies = await this.pressMeasured(
      characters.map((ch) => (ch === "\n" ? "Enter" : ch === "\b" ? "Backspace" : ch)),
      intervalMs,
      async (_, index) => {
        const after = await this.page.evaluate(readEditable, range);
        assertTypedKey(before, after, characters[index]!);
        before = after;
      },
    );
    const after = await this.page.evaluate(readEditable, range);
    if (
      after.kind !== before.kind ||
      after.target !== before.target ||
      after.text !== before.text ||
      after.head !== before.head
    ) {
      throw new Error("typing text or caret changed after the measured keys");
    }
    if (range) {
      const final = await this.page.evaluate(readEditable, undefined);
      const to = range.to + final.text.length - initial.text.length;
      if (
        final.kind !== initial.kind ||
        final.target !== initial.target ||
        final.head !== before.head + range.from ||
        final.text.slice(0, range.from) !== initial.text.slice(0, range.from) ||
        final.text.slice(range.from, to) !== before.text ||
        final.text.slice(to) !== initial.text.slice(range.to)
      ) {
        throw new Error("typing changed text outside the intended insertion or left an incorrect caret");
      }
    }
    return latencies;
  }

  /** Presses `keys` `intervalMs` apart and returns keydown → next frame for each. */
  async pressMeasured(
    keys: string[],
    intervalMs: number,
    afterKey?: (key: string, index: number) => Promise<void>,
  ): Promise<number[]> {
    await this.inPage((p) => {
      p.keyLatencies = [];
      p.recordKeys = true;
    });
    try {
      for (const [index, key] of keys.entries()) {
        const started = Date.now();
        await this.page.keyboard.press(key);
        await afterKey?.(key, index);
        const wait = intervalMs - (Date.now() - started);
        if (wait > 0) await this.page.waitForTimeout(wait);
      }
      await this.inPage((p) => p.afterNextPaint().then(() => p.afterNextPaint()));
      const latencies = await this.inPage((p) => p.keyLatencies);
      if (latencies.length !== keys.length || latencies.some((latency) => !Number.isFinite(latency) || latency < 0)) {
        throw new Error(`key sample count mismatch: expected ${keys.length}, received ${latencies.length}`);
      }
      return latencies;
    } finally {
      await this.inPage((p) => {
        p.recordKeys = false;
      });
    }
  }

  /** Checks the actual selected option after every ArrowDown, including virtualized lists. */
  async completionArrowsMeasured(count: number, intervalMs: number) {
    const selection = () =>
      this.page.evaluate(() => {
        const selected = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]');
        const index = selected?.id.match(/-(\d+)$/)?.[1];
        if (!selected || index === undefined) throw new Error("completion selection is unavailable");
        return { id: selected.id, index: Number(index) };
      });
    let before = await selection();
    return this.pressMeasured(Array(count).fill("ArrowDown"), intervalMs, async () => {
      const after = await selection();
      if (after.id === before.id || after.index !== before.index + 1) {
        throw new Error(`completion selection did not advance from ${before.index} to ${before.index + 1}`);
      }
      before = after;
    });
  }

  /** A far jump must move both the active caret and its viewport to the document end. */
  async jumpToEnd(timeoutMs = 5_000) {
    await this.inPage((p) => p.afterNextPaint());
    const start = await this.page.evaluate(() => {
      const w = window as unknown as { __openideaPerf: EditorProbe };
      const state = w.__openideaPerf.editorState();
      const scroller = document.activeElement?.closest(".cm-editor")?.querySelector(".cm-scroller");
      if (!state || !scroller || state.head === state.length || scroller.scrollHeight <= scroller.clientHeight) {
        throw new Error("jump start must be outside the destination in a scrollable editor");
      }
      return { path: state.path, head: state.head, scrollTop: scroller.scrollTop };
    });
    return this.measure(
      () => this.page.keyboard.press("ControlOrMeta+End"),
      ".cm-content",
      null,
      timeoutMs,
      (start) => {
        const w = window as unknown as { __openideaPerf: EditorProbe };
        const state = w.__openideaPerf.editorState();
        const editor = document.activeElement?.closest(".cm-editor");
        const scroller = editor?.querySelector(".cm-scroller");
        const bottom = scroller?.getBoundingClientRect().bottom;
        return (
          !!state &&
          state.path === start.path &&
          state.head === state.length &&
          state.head !== start.head &&
          !!scroller &&
          scroller.scrollTop > start.scrollTop + scroller.clientHeight &&
          bottom !== undefined &&
          w.__openideaPerf.lineAtY(bottom - 4) === state.lines - 1
        );
      },
      start,
    );
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
  async openFile(path: string, text?: string, timeoutMs = 15_000): Promise<number> {
    if (text !== undefined) await this.seed(path, text);
    return this.page.evaluate(openFileMeasured, { path, text, timeoutMs });
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
    return this.page.evaluate(() => {
      const w = window as unknown as { __openideaPerf: EditorProbe };
      return w.__openideaPerf.editorState();
    });
  }
}
