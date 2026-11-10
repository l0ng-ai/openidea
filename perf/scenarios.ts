/**
 * Interaction scenarios. Each returns flat metrics (lower is better); budgets in
 * `budgets.json` are keyed `<scenario>.<metric>`.
 */
import { Harness, type Metrics, type Scenario } from "./lib/harness.ts";
import { frameSummary, keySummary, latencySummary, totalBlockingTime } from "./lib/stats.ts";
import { startTuiRowObserver, stopTuiRowObserver } from "./lib/tuiRows.ts";

const ROOT = "/dev/acme-api";
const SAMPLE = `${ROOT}/src/main/kotlin/com/acme/orders/service/OrderService.kt`;

/** ~`lines` lines of TypeScript with a unique first line. */
function tsSource(lines: number, tag: string): string {
  const out = [`// ${tag}`, `import { Injectable } from "./di";`, ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `/** Repository for entity ${i}. */`,
      `export class Repository${i}<T extends { id: number }> {`,
      `  private readonly items = new Map<number, T>();`,
      `  constructor(private readonly name = "repo-${i}") {}`,
      `  find(id: number): T | undefined {`,
      `    return this.items.get(id) ?? (id > ${i} ? undefined : this.items.get(${i}));`,
      `  }`,
      `  save(item: T): void {`,
      `    if (item.id < 0) throw new Error(\`invalid id \${item.id} in \${this.name}\`);`,
      `    this.items.set(item.id, item);`,
      `  }`,
      `}`,
      ``,
    );
  }
  return out.join("\n");
}

/** ~`lines` lines of an Angular template: bindings, interpolations and control-flow blocks. */
function angularTemplate(lines: number, tag: string): string {
  const out = [`<!-- ${tag} -->`];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `<section class="card" [class.active]="selected() === ${i}">`,
      `  <h2 (click)="select(${i})">{{ title${i}() | titlecase }}</h2>`,
      `  @if (items${i}().length) {`,
      `    <ul>`,
      `      @for (item of items${i}(); track item.id; let last = $last) {`,
      `        <li [title]="item.label" (keydown.enter)="open(item)">{{ item.name }} &amp; {{ item.count }}</li>`,
      `      } @empty {`,
      `        <li>None</li>`,
      `      }`,
      `    </ul>`,
      `  } @else {`,
      `    <p>Loading</p>`,
      `  }`,
      `</section>`,
      `@let total${i} = items${i}().length + ${i};`,
      ``,
    );
  }
  return out.join("\n");
}

const TYPED = 'val total = orders.sumOf { it.amount * (1 + rate) }\nif (total > limit) log("over limit")\n';

/** Typing at a brisk pace (~12 keys/s) in the small Kotlin sample. */
const typing: Scenario = {
  id: "typing",
  title: "Type into a small Kotlin file",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return typeAndMeasure(h, TYPED, 80);
  },
};

/**
 * The same typing in the middle of a ~20k-line (≈ 700 KB) TypeScript file, once
 * the background parse after opening has settled.
 */
const typingLarge: Scenario = {
  id: "typingLarge",
  title: "Type into a 20k-line TypeScript file",
  async run(h) {
    const openMs = await h.openFile(`${ROOT}/src/big/Repositories.ts`, tsSource(20_000, "big"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.parserIdle();
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return { openMs, ...(await typeAndMeasure(h, "const total = items.reduce((a, b) => a + b.id, 0);\n", 80)) };
  },
};

/**
 * The same typing in the middle of a ~12k-line Angular template (an
 * `angular.json` above it): its text, attributes and blocks are nested parses.
 */
const typingAngular: Scenario = {
  id: "typingAngular",
  title: "Type into a 12k-line Angular template",
  async run(h) {
    await h.seed(`${ROOT}/web/angular.json`, "{}");
    const openMs = await h.openFile(`${ROOT}/web/src/app/big.component.html`, angularTemplate(12_000, "big"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.parserIdle();
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return { openMs, ...(await typeAndMeasure(h, "@if (open()) { {{ total + 1 }} items }\n", 80)) };
  },
};

/**
 * Code completion with a language server's 2,000 items: the first letter opens
 * the popup (after CodeMirror's 100 ms typing delay), each further letter
 * narrows it, arrows move the selection.
 */
const completion: Scenario = {
  id: "completion",
  title: "Code completion over 2,000 items",
  async run(h) {
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: { fakeCompletion(n: number): void } }).__openideaPerf.fakeCompletion(2_000),
    );
    try {
      await h.openFile(`${ROOT}/src/completion/Orders.ts`, tsSource(2_000, "completion"));
      const st = await h.editorState();
      await h.setCursor(Math.floor((st?.length ?? 0) / 2));
      await h.parserIdle();
      await h.page.keyboard.press("End");
      await h.page.keyboard.press("Enter");
      const refresh = await h.refreshMs();
      const openMs = await h.measure(() => h.page.keyboard.press("g"), ".cm-tooltip-autocomplete li", "Result<Order>");
      const t0 = await h.now();
      const before = await h.counters();
      const narrow = await h.typeMeasured("etOrd", 150);
      const work = Harness.delta(before, await h.counters());
      const arrows = await h.pressMeasured(Array(20).fill("ArrowDown"), 60);
      await h.page.keyboard.press("Escape");
      return {
        openMs,
        ...keySummary(narrow, refresh, "narrow"),
        narrowMainThreadMsPerKey: work.taskMs / 5,
        ...keySummary(arrows, refresh, "arrow"),
        tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      };
    } finally {
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { fakeCompletion(n: number): void } }).__openideaPerf.fakeCompletion(0),
      );
    }
  },
};

/**
 * A process printing 50,000 log lines (stack frames among them) at 200 lines a
 * frame (~4 s) into the Run console, while the user types in an editor: the
 * console must keep up and the editor must stay responsive.
 */
const consoleOutput: Scenario = {
  id: "consoleOutput",
  title: "Type while the Run console streams 50k lines",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    const streamMs = h.page.evaluate(async () => {
      const w = window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } };
      const started = performance.now();
      await w.__openideaPerf.runAction("run.sampleOutput", { lines: 50_000, perFrame: 200 });
      return performance.now() - started;
    });
    // The console takes focus with it; type back in the editor while it streams.
    await h.page.waitForTimeout(100);
    await h.setCursor((await h.editorState())?.head ?? 0);
    const keys = await h.typeMeasured(TYPED.slice(0, 40), 70);
    const total = await streamMs;
    const frames = await h.inPage((p) => p.stopFrames());
    await h.inPage((p) => p.waitShown("body", "processed order #49998", 5_000));
    return {
      // 250 frames of output at the display rate is the floor.
      streamMs: total,
      ...frameSummary(frames, refresh),
      ...keySummary(keys, refresh, "key"),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/**
 * A full-screen agent TUI (Claude Code, Grok) repainting the terminal 10 times a second
 * for 6 s — every row rewritten, only the spinner row changed — while the user types in
 * an editor. Guards the terminal's unchanged-row skip: without it every frame restyles
 * and lays out the whole screen.
 */
const TUI_FRAMES = 60;
const terminalTui: Scenario = {
  id: "terminalTui",
  title: "Type while a full-screen TUI repaints the terminal",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    // Open the terminal and let it settle before measuring.
    const opened = await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
      ).__openideaPerf.runAction("terminal.sampleTui", { frames: 1, fps: 10 }),
    );
    if (!opened) throw new Error("terminal.sampleTui is unavailable");
    await h.page.waitForTimeout(300);
    await h.setCursor((await h.editorState())?.head ?? 0);
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    const before = await h.counters();
    await h.page.evaluate(startTuiRowObserver);
    await h.inPage((p) => p.startFrames());
    const stream = h.page.evaluate(
      (frames) =>
        (
          window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
        ).__openideaPerf.runAction("terminal.sampleTui", { frames, fps: 10 }),
      TUI_FRAMES,
    );
    let keys: number[];
    let rebuilt: number;
    try {
      await h.page.waitForTimeout(200);
      await h.setCursor((await h.editorState())?.head ?? 0);
      keys = await h.typeMeasured(TYPED.slice(0, 40), 70);
      if (!(await stream)) throw new Error("terminal.sampleTui is unavailable");
    } finally {
      rebuilt = await h.page.evaluate(stopTuiRowObserver);
    }
    const frames = await h.inPage((p) => p.stopFrames());
    const work = Harness.delta(before, await h.counters());
    return {
      // ~1 with unchanged rows left in place (only the spinner row changes), the screen height without.
      rowsRebuiltPerTuiFrame: rebuilt / TUI_FRAMES,
      styleLayoutMsPerTuiFrame: work.styleLayoutMs / TUI_FRAMES,
      scriptMsPerTuiFrame: work.scriptMs / TUI_FRAMES,
      ...frameSummary(frames, refresh),
      ...keySummary(keys, refresh, "key"),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/** Held key: auto-repeat at ~30 Hz must never fall behind. */
const keyRepeat: Scenario = {
  id: "keyRepeat",
  title: "Auto-repeat a key in a 20k-line file",
  async run(h) {
    await h.openFile(`${ROOT}/src/big/Repeat.ts`, tsSource(20_000, "repeat"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 3));
    await h.parserIdle();
    return typeAndMeasure(h, "x".repeat(90), 33);
  },
};

async function typeAndMeasure(h: Harness, text: string, intervalMs: number): Promise<Metrics> {
  const refresh = await h.refreshMs();
  const t0 = await h.now();
  const before = await h.counters();
  const lat = await h.typeMeasured(text, intervalMs);
  const work = Harness.delta(before, await h.counters());
  const keys = text.length;
  return {
    ...keySummary(lat, refresh),
    // Counts look high (a frame re-styles after CodeMirror's measure writes), so budget the time.
    styleLayoutMsPerKey: work.styleLayoutMs / keys,
    scriptMsPerKey: work.scriptMs / keys,
    mainThreadMsPerKey: work.taskMs / keys,
    tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
  };
}

/**
 * Wheel-scrolling a large file: frame pacing while CodeMirror renders new lines.
 * `frame*` / `droppedFramesPct`: 120 px per frame (one wheel notch, ≈ 7 200 px/s,
 * a fast trackpad). `fling*`: 600 px per frame, a whole screen each frame — a
 * stress test without a budget.
 */
const scroll: Scenario = {
  id: "scroll",
  title: "Wheel-scroll a 20k-line file",
  async run(h) {
    await h.openFile(`${ROOT}/src/big/Scroll.ts`, tsSource(20_000, "scroll"));
    await h.parserIdle();
    const refresh = await h.refreshMs();
    const box = (await h.page.locator(".cm-scroller").first().boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    const wheel = async (steps: number, dy: number) => {
      await h.inPage((p) => p.startFrames());
      for (let i = 0; i < steps; i++) {
        await h.page.mouse.wheel(0, i < steps / 2 ? dy : -dy);
        await h.page.waitForTimeout(16);
      }
      await h.page.waitForTimeout(200);
      return h.inPage((p) => p.stopFrames());
    };
    const smooth = frameSummary(await wheel(160, 120), refresh);
    const tbtMs = totalBlockingTime(await h.longTasksSince(t0));
    const fling = frameSummary(await wheel(60, 600), refresh);
    // Jump far: scrollbar drag / Ctrl+End style repositioning.
    const jumpMs = await h.measure(
      () => h.page.keyboard.press("Control+End"),
      ".cm-content",
      "export class Repository",
      5_000,
    );
    return {
      ...smooth,
      tbtMs,
      flingFrameP95Ms: fling.frameP95Ms,
      flingDroppedFramesPct: fling.droppedFramesPct,
      jumpMs,
    };
  },
};

/**
 * Git Log with 20,000 commits on branching lanes, loaded page by page as the
 * backend does (150 ms a page, like `git log`): showing it, walking the
 * selection with the arrow keys (the details pane follows) and wheel-scrolling
 * through several pages.
 */
const gitLog: Scenario = {
  id: "gitLog",
  title: "Show, navigate and scroll a 20k-commit Git Log",
  async run(h) {
    await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { fakeGitLog(n: number, latencyMs?: number): void } }
      ).__openideaPerf.fakeGitLog(20_000, 150),
    );
    const showMs = await h.measure(
      () =>
        h.page.evaluate(() =>
          (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
            "vcs.showLog",
          ),
        ),
      '[role="listbox"][aria-label="Commits"]',
      "order flow step 0",
    );
    const refresh = await h.refreshMs();
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.getByRole("option").first().click();
    const keyLat = await h.pressMeasured(Array(40).fill("ArrowDown"), 50);
    const box = (await list.boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    // Far enough to load several more pages on the way.
    for (let i = 0; i < 160; i++) {
      await h.page.mouse.wheel(0, i < 120 ? 600 : -600);
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      showMs,
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      ...keySummary(keyLat, refresh, "arrowKey"),
    };
  },
};

/** Scrollbar-sized jumps across a loaded graph, rather than incremental wheel scrolling. */
const gitLogScrollbar: Scenario = {
  id: "gitLogScrollbar",
  title: "Drag through a loaded 6k-commit Git Log",
  async run(h) {
    await h.page.evaluate(async () => {
      const probe = (
        window as never as {
          __openideaPerf: {
            fakeGitLog(n: number): void;
            runAction(id: string): Promise<boolean>;
          };
        }
      ).__openideaPerf;
      probe.fakeGitLog(6000);
      await probe.runAction("vcs.showLog");
    });
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.waitFor();
    await list.evaluate(async (element) => {
      for (let i = 0; i < 300 && element.scrollHeight < 6000 * 26; i++) {
        element.scrollTop = element.scrollHeight;
        await new Promise(requestAnimationFrame);
      }
      if (element.scrollHeight < 6000 * 26) throw new Error("Git Log did not finish loading");
      element.scrollTop = 0;
    });
    await h.page.waitForTimeout(200);
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    await list.evaluate(async (element) => {
      const max = element.scrollHeight - element.clientHeight;
      for (let i = 0; i < 180; i++) {
        element.scrollTop = ((i < 90 ? i : 180 - i) / 90) * max;
        await new Promise(requestAnimationFrame);
      }
    });
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/**
 * Dragging the splitters with an editor, the Project tree and the Git Log
 * open: every pointer move resizes the islands, so each frame relays them out.
 */
const resizePanels: Scenario = {
  id: "resizePanels",
  title: "Drag the tool window splitters",
  async run(h) {
    await h.openFile(SAMPLE);
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: { fakeGitLog(n: number): void } }).__openideaPerf.fakeGitLog(2_000),
    );
    await h.measure(
      () =>
        h.page.evaluate(() =>
          (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
            "vcs.showLog",
          ),
        ),
      '[role="listbox"][aria-label="Commits"]',
      "order flow step 0",
    );
    const refresh = await h.refreshMs();
    const drag = async (name: string, dx: number, dy: number) => {
      const box = (await h.page.getByRole("separator", { name }).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await h.page.mouse.move(x, y);
      await h.page.mouse.down();
      await h.inPage((p) => p.startFrames());
      // Out and back twice, one pointer move a frame.
      for (let i = 0; i < 120; i++) {
        const t = Math.sin((i / 60) * Math.PI);
        await h.page.mouse.move(x + dx * t, y + dy * t);
        await h.page.waitForTimeout(16);
      }
      await h.page.mouse.up();
      await h.page.waitForTimeout(200);
      return frameSummary(await h.inPage((p) => p.stopFrames()), refresh);
    };
    const t0 = await h.now();
    const side = await drag("Resize left tool window", 300, 0);
    const bottom = await drag("Resize bottom tool window", 0, -250);
    return {
      ...side,
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      bottomFrameP95Ms: bottom.frameP95Ms,
      bottomDroppedFramesPct: bottom.droppedFramesPct,
    };
  },
};

/** Cold load: navigation → Project tree painted. */
const startup: Scenario = {
  id: "startup",
  title: "Load the workbench",
  blank: true,
  async run(h) {
    const readyMs = await h.load();
    const paints = await h.page.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, e.startTime])),
    );
    await h.gc();
    const nodes = (await h.counters()).Nodes ?? NaN;
    return {
      readyMs,
      fcpMs: paints["first-contentful-paint"] ?? NaN,
      tbtMs: totalBlockingTime(await h.longTasksSince(0)),
      heapMb: await h.heapMb(),
      domNodes: nodes,
    };
  },
};

/** Opening files: small sample, then switching between eight open tabs. */
const tabs: Scenario = {
  id: "tabs",
  title: "Open files and switch tabs",
  async run(h) {
    const openSmallMs = await h.openFile(SAMPLE);
    const names: string[] = [];
    for (let i = 0; i < 8; i++) {
      const name = `Module${i}.ts`;
      names.push(name);
      await h.openFile(`${ROOT}/src/tabs/${name}`, tsSource(2_000, `tab-${i}`));
    }
    const switches: number[] = [];
    // Recently shown tabs keep their editor view: showing one again must not build a new one.
    let viewsRebuilt = 0;
    let switchWork = await h.counters();
    for (let round = 0; round < 3; round++) {
      if (round === 1) switchWork = await h.counters();
      for (let i = 0; i < names.length; i++) {
        const tab = h.page.getByRole("tab", { name: names[i], exact: true });
        switches.push(await h.measure(() => tab.click(), ".cm-content", `// tab-${i}`));
        const fresh = await h.page.evaluate(() => {
          const view = document.querySelector("[data-editor-host] .cm-editor") as { perfSeen?: boolean } | null;
          if (!view || view.perfSeen) return false;
          view.perfSeen = true;
          return true;
        });
        if (round > 0 && fresh) viewsRebuilt++;
      }
    }
    const work = Harness.delta(switchWork, await h.counters());
    // The Switcher (Ctrl+Tab) back and forth between the two most recent tabs.
    const before = await h.counters();
    const switcher: number[] = [];
    for (let i = 0; i < 10; i++) {
      const tag = i % 2 ? names.length - 1 : names.length - 2;
      switcher.push(await h.measure(() => h.pressAction("navigate.switcher"), ".cm-content", `// tab-${tag}`));
      await h.page.waitForTimeout(150);
    }
    const switcherWork = Harness.delta(before, await h.counters());
    return {
      openSmallMs,
      ...latencySummary(switches, "switch"),
      switchMainThreadMs: work.taskMs / (names.length * 2),
      viewsRebuilt,
      ...latencySummary(switcher, "switcher"),
      switcherMainThreadMs: switcherWork.taskMs / switcher.length,
    };
  },
};

/**
 * Two agent tasks with long conversations (150 turns, 2,100 entries) in editor tabs:
 * switching between them with the Switcher (Ctrl+Tab) shows a kept-alive conversation
 * again, which must not restyle its whole history; then scrolling up through one.
 * Chromium anchors scrolling on its own (WebKit doesn't), so anchoring is turned off
 * here: rows that take their real height only once scrolled into view would jump.
 */
const agentTabs: Scenario = {
  id: "agentTabs",
  title: "Switch between and scroll long agent conversations",
  async run(h) {
    await h.page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
      ).__openideaPerf.runAction("agents.openSampleConversations", { tasks: 2, turns: 150 }),
    );
    const shown = (n: number) => `[data-editor-focus] span[title="Sample task ${n}"]`;
    // Both conversations get their earlier entries painted in background batches, also the
    // first one, hidden behind the second as soon as it opened.
    await h.page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-message]")]
          .map((m) => m.parentElement!)
          .filter((stream, i, all) => all.indexOf(stream) === i && stream.textContent!.includes("Turn 0:")).length ===
        2,
      undefined,
      { timeout: 30_000, polling: 200 },
    );
    // Rows painted while hidden are laid out the first time their conversation shows.
    for (const n of [1, 2]) {
      await h.page.getByRole("tab", { name: `Sample task ${n}` }).click();
      await h.page.locator(shown(n)).waitFor();
      await h.page.waitForTimeout(300);
    }
    // WebKit restyles a hidden conversation in full when it is shown again (Chromium keeps its
    // style): what bounds that there is the history's DOM, and rows skipping rendering off screen.
    const { conversationNodes, rowsAlwaysRendered } = await h.page.evaluate((selector) => {
      const conversation = document.querySelector(selector)!.closest("[data-editor-focus]")!;
      const rows = [...conversation.querySelector("[data-message]")!.parentElement!.children];
      return {
        conversationNodes: conversation.querySelectorAll("*").length,
        rowsAlwaysRendered: rows.filter((r) => getComputedStyle(r).contentVisibility !== "auto").length,
      };
    }, shown(2));

    const t0 = await h.now();
    const before = await h.counters();
    const switches: number[] = [];
    for (let i = 0; i < 10; i++) {
      switches.push(await h.measure(() => h.pressAction("navigate.switcher"), shown(i % 2 ? 2 : 1)));
      await h.page.waitForTimeout(150);
    }
    const work = Harness.delta(before, await h.counters());
    const switchTbtMs = totalBlockingTime(await h.longTasksSince(t0));

    // Scrolling up from the end, a step at a time: how far the text under the pointer moves
    // beyond the scroll itself.
    const scrollJumps = await h.page.evaluate(async (selector) => {
      const stream = document
        .querySelector(selector)!
        .closest("[data-editor-focus]")!
        .querySelector("[data-message]")!.parentElement!;
      const frame = () => new Promise(requestAnimationFrame);
      stream.scrollTop = stream.scrollHeight;
      await frame();
      await frame();
      const top = stream.getBoundingClientRect().top;
      let jumps = 0;
      for (let i = 0; i < 100 && stream.scrollTop > 0; i++) {
        const row = [...stream.children].find((r) => r.getBoundingClientRect().bottom > top + 200)!;
        const from = row.getBoundingClientRect().top;
        const scrolled = stream.scrollTop;
        // A wheel step: the user scrolls, so the conversation stops following its end.
        stream.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
        stream.scrollTop -= 120;
        const by = scrolled - stream.scrollTop;
        await frame();
        await frame();
        if (Math.abs(row.getBoundingClientRect().top - from - by) > 2) jumps++;
      }
      stream.scrollTop = stream.scrollHeight;
      return jumps;
    }, shown(2));

    const refresh = await h.refreshMs();
    const box = (await h.page.locator("[data-editor-focus]").boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await h.page.waitForTimeout(200);
    const t1 = await h.now();
    await h.inPage((p) => p.startFrames());
    for (let i = 0; i < 120; i++) {
      await h.page.mouse.wheel(0, -120);
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const scroll = frameSummary(await h.inPage((p) => p.stopFrames()), refresh);
    return {
      conversationNodes,
      rowsAlwaysRendered,
      ...latencySummary(switches, "switch"),
      switchMainThreadMs: work.taskMs / switches.length,
      switchStyleLayoutMs: work.styleLayoutMs / switches.length,
      switchTbtMs,
      scrollJumps,
      scrollFrameP95Ms: scroll.frameP95Ms,
      scrollDroppedFramesPct: scroll.droppedFramesPct,
      scrollTbtMs: totalBlockingTime(await h.longTasksSince(t1)),
    };
  },
};

/** Find Action and Search Everywhere: open, then query → first result painted. */
const popups: Scenario = {
  id: "popups",
  title: "Find Action / Search Everywhere",
  async run(h) {
    await h.openFile(SAMPLE);
    const findActionOpenMs = await h.measure(() => h.pressAction("navigate.findAction"), '[role="dialog"] input');
    const findActionQueryMs = await h.measure(
      () => h.page.keyboard.insertText("memory indicator"),
      '[role="dialog"] [role="option"]',
      "Memory Indicator",
    );
    // Editing the query: Backspace → list re-filtered and painted.
    const refresh = await h.refreshMs();
    const keyLat = await h.typeMeasured("\b\b\b\b\b\b", 80);
    await h.page.keyboard.press("Escape");
    await h.page.locator('[role="dialog"]').waitFor({ state: "detached" });

    const seOpenMs = await h.measure(
      () => h.pressAction("navigate.searchEverywhere"),
      '[role="dialog"][aria-label="Search Everywhere"] input',
    );
    const seQueryMs = await h.measure(
      () => h.page.keyboard.insertText("language servers"),
      '[role="dialog"] [role="option"]',
      "Language Servers",
    );
    await h.page.keyboard.press("Escape");
    return {
      findActionOpenMs,
      findActionQueryMs,
      ...keySummary(keyLat, refresh, "findActionKey"),
      searchEverywhereOpenMs: seOpenMs,
      searchEverywhereQueryMs: seQueryMs,
    };
  },
};

const TOOL_WINDOWS: Array<[string, string]> = [
  ["toolwindow.problems", "Problems"],
  ["toolwindow.run", "Run"],
  ["toolwindow.structure", "Structure"],
  ["toolwindow.commit", "Commit"],
  ["toolwindow.git", "Git"],
  ["toolwindow.terminal", "Terminal"],
];

/** Showing tool windows by shortcut (first show loads and mounts the view). */
const toolWindows: Scenario = {
  id: "toolWindows",
  title: "Show tool windows",
  async run(h) {
    await h.openFile(SAMPLE);
    const m: Metrics = {};
    const all: number[] = [];
    for (const [action, title] of TOOL_WINDOWS) {
      // Until the view's content is laid out (lazily loaded views render nothing at first).
      const ms = await h.measure(
        () => h.pressAction(action),
        `section[aria-label="${title}"] [data-toolwindow-body] > *`,
      );
      m[`${title.toLowerCase()}Ms`] = ms;
      all.push(ms);
      await h.pressAction(action);
      await h.page.locator(`section[aria-label="${title}"]`).waitFor({ state: "hidden" });
    }
    return { maxMs: Math.max(...all), ...m };
  },
};

/** Project tree: expand a 10 000-entry folder and scroll through it. */
const projectTree: Scenario = {
  id: "projectTree",
  title: "Expand and scroll a 10k-entry folder",
  async run(h) {
    const generated = h.page.locator('[role="treeitem"][aria-level="2"]', { hasText: "generated" }).first();
    await generated.click();
    const expandMs = await h.measure(
      () => h.page.keyboard.press("ArrowRight"),
      '[role="tree"][aria-label="Project"]',
      "item1.json",
    );
    const refresh = await h.refreshMs();
    // Selection walks into the expanded folder (rows stay rendered: no scroll yet).
    const keyLat = await h.pressMeasured(Array(30).fill("ArrowDown"), 50);
    const box = (await h.page.getByRole("tree", { name: "Project" }).boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    for (let i = 0; i < 60; i++) {
      await h.page.mouse.wheel(0, 500);
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      expandMs,
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      ...keySummary(keyLat, refresh, "arrowKey"),
    };
  },
};

/** Opening and closing editors repeatedly must not grow the heap or the DOM. */
const leaks: Scenario = {
  id: "leaks",
  title: "Open / close 10 editors × 4",
  async run(h) {
    const cycle = async (n: number) => {
      for (let i = 0; i < 10; i++)
        await h.openFile(`${ROOT}/src/leak/File${n}_${i}.ts`, tsSource(1_500, `leak-${n}-${i}`));
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
          "editor.closeAllTabs",
        ),
      );
      await h.page.locator(".cm-editor").waitFor({ state: "detached" });
    };
    await cycle(0);
    await h.gc();
    const heap0 = await h.heapMb();
    const c0 = await h.counters();
    for (let n = 1; n <= 3; n++) await cycle(n);
    await h.gc();
    const c1 = await h.counters();
    return {
      heapGrowthMb: (await h.heapMb()) - heap0,
      domNodeGrowth: (c1.Nodes ?? 0) - (c0.Nodes ?? 0),
      listenerGrowth: (c1.JSEventListeners ?? 0) - (c0.JSEventListeners ?? 0),
    };
  },
};

export const SCENARIOS: Scenario[] = [
  startup,
  typing,
  typingLarge,
  typingAngular,
  completion,
  consoleOutput,
  terminalTui,
  gitLog,
  gitLogScrollbar,
  resizePanels,
  keyRepeat,
  scroll,
  tabs,
  agentTabs,
  popups,
  toolWindows,
  projectTree,
  leaks,
];
