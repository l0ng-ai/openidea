/**
 * Instrumentation injected before the app loads (`page.addInitScript`). It must
 * be self-contained: Playwright serialises the function source.
 *
 * Latency = input event timestamp → start of the first frame that shows its
 * effect (the requestAnimationFrame callback of that frame). Rendering that
 * frame follows within it; its main-thread cost is reported separately from
 * CDP counters. (A "message after rAF" end point was tried and dropped: Chrome
 * sometimes defers that task by a whole frame, which shows up as fake jank.)
 */

export interface InPage {
  /** keydown → next frame, per key while `recordKeys` is on. */
  keyLatencies: number[];
  recordKeys: boolean;
  /** Timestamp of the latest keydown / pointerdown / wheel / input event. */
  lastInput: number;
  frames: number[] | null;
  longTasks: Array<{ start: number; duration: number }>;
  afterNextPaint(): Promise<number>;
  startFrames(): void;
  stopFrames(): number[];
  /** Arms a current-input transition; unarmed waits remain navigation observations. */
  arm(): number;
  cancel(token: number): void;
  waitShown(
    selector: string,
    text: string | null,
    timeoutMs: number,
    token?: number,
    check?: () => boolean,
  ): Promise<number>;
}

export function installInPage() {
  const w = window as unknown as { __perf: InPage };
  if (w.__perf) return;
  let nextToken = 0;
  let operation: { token: number; input: number; capture?: () => void; cancel?: () => void } | null = null;

  const afterNextPaint = () =>
    new Promise<number>((resolve) =>
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve(performance.now());
        ch.port2.postMessage(0);
      }),
    );

  const onInput = (e: Event) => {
    const t = e.timeStamp;
    h.lastInput = t;
    if (operation && operation.input < 0) {
      operation.input = t;
      operation.capture?.();
    }
    if (e.type === "keydown" && h.recordKeys) requestAnimationFrame(() => h.keyLatencies.push(performance.now() - t));
  };
  // `input` covers `keyboard.insertText`, which dispatches no keydown.
  for (const type of ["keydown", "pointerdown", "wheel", "input"]) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  const h: InPage = {
    keyLatencies: [],
    recordKeys: false,
    lastInput: 0,
    frames: null,
    longTasks: [],
    afterNextPaint,
    startFrames() {
      const frames: number[] = [];
      h.frames = frames;
      let prev = -1;
      const tick = (t: number) => {
        if (h.frames !== frames) return;
        if (prev >= 0) frames.push(t - prev);
        prev = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stopFrames() {
      const f = h.frames ?? [];
      h.frames = null;
      return f;
    },
    arm() {
      if (operation) throw new Error("a measurement is already armed");
      const token = ++nextToken;
      operation = { token, input: -1 };
      return token;
    },
    cancel(token) {
      if (operation?.token !== token) return;
      operation.cancel?.();
      operation = null;
    },
    waitShown(selector, text, timeoutMs, token, check) {
      const current = token === undefined ? null : operation;
      if (token !== undefined && current?.token !== token) return Promise.reject(new Error("measurement is not armed"));
      const deadline = performance.now() + timeoutMs;
      const snapshot = () => {
        if (check && !check()) return [];
        return [...document.querySelectorAll<HTMLElement>(selector)]
          .filter(
            (el) =>
              el.getClientRects().length > 0 &&
              getComputedStyle(el).visibility === "visible" &&
              !el.closest('[aria-hidden="true"]') &&
              (text === null || (el.textContent ?? "").includes(text)),
          )
          .map((el) => ({
            el,
            text: el.textContent,
            value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null,
            selected: el.getAttribute("aria-selected"),
          }));
      };
      let baseline = snapshot();
      if (current)
        current.capture = () => {
          baseline = snapshot();
        };
      return new Promise<number>((resolve, reject) => {
        let stopped = false;
        const finish = () => {
          stopped = true;
          if (operation === current) operation = null;
        };
        if (current)
          current.cancel = () => {
            finish();
            reject(new Error("measurement cancelled"));
          };
        const tick = () => {
          if (stopped) return;
          const frameStart = performance.now();
          const shown = snapshot();
          const changed = shown.some(
            (now) =>
              !baseline.some(
                (old) =>
                  old.el === now.el &&
                  old.text === now.text &&
                  old.value === now.value &&
                  old.selected === now.selected,
              ),
          );
          // Keep the endpoint at frame start, but only credit this input's target transition.
          if (shown.length && (!current || (current.input >= 0 && changed))) {
            const start = current?.input ?? 0;
            finish();
            resolve(frameStart - start);
          } else if (performance.now() > deadline) {
            finish();
            reject(new Error(`timed out waiting for ${selector}${text ? ` containing "${text}"` : ""}`));
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };
  w.__perf = h;

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) h.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // Long Tasks API unavailable: TBT is reported as 0.
  }
}
