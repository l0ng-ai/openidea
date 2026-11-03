/**
 * Interaction scenarios. Each returns flat metrics (lower is better); budgets in
 * `budgets.json` are keyed `<scenario>.<metric>`.
 */
import { Harness, type Metrics, type Scenario } from "./lib/harness.ts";
import { frameSummary, keySummary, latencySummary, totalBlockingTime } from "./lib/stats.ts";

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
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < names.length; i++) {
        const tab = h.page.getByRole("tab", { name: names[i], exact: true });
        switches.push(await h.measure(() => tab.click(), ".cm-content", `// tab-${i}`));
      }
    }
    return { openSmallMs, ...latencySummary(switches, "switch") };
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
  keyRepeat,
  scroll,
  tabs,
  popups,
  toolWindows,
  projectTree,
  leaks,
];
