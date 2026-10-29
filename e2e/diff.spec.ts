/**
 * The diff viewer over a real git repository (`diffRepo.ts`): each case opens
 * HEAD against the working copy and checks the IDEA-style change types of
 * lines and words, the difference count against `git diff`, and that the
 * 10,000-line files open, scroll and navigate in every viewer mode.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { gitHunks, readSides, tempDiffRepo } from "./diffRepo";
import { expect, test } from "./fixtures";

type Kind = "modified" | "inserted" | "deleted";

interface Opts {
  mode?: "split" | "unified";
  /** Padded panes (true), or panes joined by a curved divider (false, the default). */
  alignChanges?: boolean;
  syncScroll?: boolean;
  collapse?: boolean;
  ignore?: "none" | "trim" | "whitespace" | "whitespaceAndLines";
}

let repo = "";
test.beforeAll(() => {
  repo = tempDiffRepo();
});
test.afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Diff" });
const counter = (page: Page) =>
  toolbar(page)
    .locator("span")
    .filter({ hasText: /differen|identical/ });

/** Opens HEAD ↔ working tree of `path` and waits until the difference count shows; returns the time it took. */
async function openCase(page: Page, path: string, opts: Opts = {}): Promise<number> {
  const { left, right } = readSides(repo, path);
  const options = {
    mode: "split",
    ignore: "none",
    highlight: "words",
    collapse: false,
    alignChanges: true,
    syncScroll: true,
    ...opts,
  };
  const started = Date.now();
  await page.evaluate(
    async ({ path, left, right, options }) => {
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify(options));
      const actions = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction("diff.compareTexts", {
        path,
        title: path,
        left: { text: left, label: "HEAD" },
        right: { text: right, label: "Working tree" },
      });
    },
    { path, left, right, options },
  );
  await expect(counter(page)).toBeVisible({ timeout: 20_000 });
  const elapsed = Date.now() - started;
  // Word highlights land a microtask after both panes exist.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return elapsed;
}

interface Side {
  lines: Kind[];
  words: [string, Kind][];
}

/** Change types of the rendered lines and words of each pane (`a` / `b`; unified: `b` only). */
async function rendered(page: Page): Promise<{ a: Side; b: Side; deletedChunks: number }> {
  return page
    .locator(".cm-mergeView, .cm-editor.cm-merge-b")
    .first()
    .evaluate((el) => {
      const root = el.closest("[role=region]") ?? el;
      const kind = (e: Element, prefix: string) =>
        (e.className.match(new RegExp(`${prefix}-(modified|inserted|deleted)`))?.[1] ?? null) as Kind | null;
      const side = (cls: string) => {
        const ed = root.querySelector(`.cm-editor.cm-merge-${cls}`);
        const lines = [...(ed?.querySelectorAll(".cm-content > .cm-line") ?? [])]
          .map((l) => kind(l, "cm-diffLine"))
          .filter((k): k is Kind => !!k);
        const words = [...(ed?.querySelectorAll(".cm-diffWord") ?? [])].map(
          (w) => [w.textContent ?? "", kind(w, "cm-diffWord")!] as [string, Kind],
        );
        return { lines, words };
      };
      return { a: side("a"), b: side("b"), deletedChunks: root.querySelectorAll(".cm-deletedChunk").length };
    });
}

const differences = (n: number) => (n === 1 ? "1 difference" : `${n} differences`);

async function expectCount(page: Page, path: string, n = gitHunks(repo, path)) {
  await expect(counter(page)).toHaveText(new RegExp(`^(${differences(n)}|\\d+ of ${n} differences)$`));
}

const all = (n: number, k: Kind) => Array<Kind>(n).fill(k);

async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.getByRole("region").last().screenshot({ path, animations: "disabled" });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test.describe("small cases (side-by-side, Highlight words)", () => {
  const cases: {
    path: string;
    a: Kind[];
    b: Kind[];
    wordsA?: [string, Kind][];
    wordsB?: [string, Kind][];
  }[] = [
    {
      path: "src/words.ts",
      a: all(2, "modified"),
      b: all(2, "modified"),
      wordsA: [["true", "modified"]],
      wordsB: [
        ["false", "modified"],
        [" x,", "inserted"],
      ],
    },
    { path: "src/insert.ts", a: [], b: all(5, "inserted"), wordsA: [], wordsB: [] },
    { path: "src/delete.ts", a: all(4, "deleted"), b: [], wordsA: [], wordsB: [] },
    {
      path: "docs/readme-zh.md",
      a: ["modified"],
      b: ["modified"],
      wordsA: [["测试", "modified"]],
      wordsB: [["示例", "modified"]],
    },
    {
      path: "docs/emoji.md",
      a: ["modified"],
      b: ["modified"],
      wordsA: [["👋", "modified"]],
      wordsB: [["🌍", "modified"]],
    },
    {
      path: "data/no-eol.txt",
      a: ["modified"],
      b: ["modified"],
      wordsA: [["beta", "modified"]],
      wordsB: [["gamma", "modified"]],
    },
    { path: "src/indent.py", a: all(3, "modified"), b: all(3, "modified") },
    { path: "src/moved.ts", a: all(5, "deleted"), b: all(5, "inserted"), wordsA: [], wordsB: [] },
    { path: "src/new-file.ts", a: [], b: all(6, "inserted"), wordsA: [], wordsB: [] },
    { path: "src/deleted-file.ts", a: all(6, "deleted"), b: [], wordsA: [], wordsB: [] },
  ];
  for (const c of cases)
    test(c.path, async ({ workbench: page }) => {
      await openCase(page, c.path);
      await expectCount(page, c.path);
      const { a, b } = await rendered(page);
      expect(a.lines, "left lines").toEqual(c.a);
      expect(b.lines, "right lines").toEqual(c.b);
      if (c.wordsA) expect(a.words, "left words").toEqual(c.wordsA);
      if (c.wordsB) expect(b.words, "right words").toEqual(c.wordsB);
    });

  test("a renamed field with a comment added reads as one modified block", async ({ workbench: page }) => {
    await openCase(page, "src/options.ts");
    await expectCount(page, "src/options.ts", 1);
    const { a, b } = await rendered(page);
    expect(a.lines).toEqual(["modified"]);
    expect(b.lines).toEqual(all(6, "modified"));
    expect(a.words).toEqual([["syncScroll", "modified"]]);
    expect(b.words.every(([, k]) => k === "modified")).toBe(true);
    const text = b.words.map(([t]) => t).join("\n");
    expect(text).toMatch(/^\/\*\*\n/);
    expect(text).toMatch(/syncScrolling$/);
    await shot(page, "options");
  });

  test("an edit in the middle of a 44,000-character minified line", async ({ workbench: page }) => {
    const path = "dist/app.min.js";
    await openCase(page, path);
    await expectCount(page, path);
    // Long lines render only around the horizontal viewport: scroll to the edit.
    const { left } = readSides(repo, path);
    const at = left.indexOf("f(1000,") / left.length;
    for (const side of ["a", "b"])
      await page
        .locator(`.cm-editor.cm-merge-${side} .cm-scroller`)
        .evaluate((s, at) => (s.scrollLeft = at * s.scrollWidth - s.clientWidth / 2), at);
    await expect.poll(async () => (await rendered(page)).a.words).toEqual([["f", "modified"]]);
    const { a, b } = await rendered(page);
    expect(a.lines).toEqual(["modified"]);
    expect(b.lines).toEqual(["modified"]);
    expect(b.words).toEqual([["g", "modified"]]);
    await shot(page, "minified");
  });

  test("a final newline added", async ({ workbench: page }) => {
    await openCase(page, "data/add-eol.txt");
    await expectCount(page, "data/add-eol.txt");
    const { a, b } = await rendered(page);
    // IDEA compares lines without their breaks: an empty line inserted, "beta" unchanged.
    expect(a.lines).toEqual([]);
    expect(b.lines).toEqual(["inserted"]);
    await shot(page, "add-eol");
  });

  test("ignoring whitespace hides an indentation-only change", async ({ workbench: page }) => {
    await openCase(page, "src/indent.py", { ignore: "whitespace" });
    await expect(counter(page)).toHaveText("No differences");
    expect((await rendered(page)).b.lines).toEqual([]);
  });

  test("unified viewer shows old lines deleted and new lines inserted", async ({ workbench: page }) => {
    await openCase(page, "src/options.ts", { mode: "unified" });
    await expectCount(page, "src/options.ts", 1);
    const { b, deletedChunks } = await rendered(page);
    expect(deletedChunks).toBe(1);
    expect(b.lines).toEqual(all(6, "inserted"));
    await shot(page, "options-unified");
  });
});

test.describe("10,000-line files", () => {
  test.describe.configure({ timeout: 60_000 });

  const modes: [string, Opts][] = [
    ["padded", {}],
    ["sync scrolling", { alignChanges: false }],
    ["unified", { mode: "unified" }],
    ["collapsed", { collapse: true }],
  ];

  /** Scrolls the diff to the end: the padded panes scroll together, the others from the right (or unified) pane. */
  async function scrollToEnd(page: Page) {
    await page
      .locator(".cm-editor.cm-merge-b")
      .first()
      .evaluate((ed) => {
        const merge = ed.closest<HTMLElement>(".cm-mergeView");
        const s =
          merge && merge.scrollHeight > merge.clientHeight ? merge : ed.querySelector<HTMLElement>(".cm-scroller")!;
        s.scrollTop = s.scrollHeight;
      });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /** Text of the first line fully shown in each pane. */
  async function topLines(page: Page) {
    return page
      .locator(".cm-mergeView")
      .first()
      .evaluate((mv) => {
        const top = (side: string) => {
          const ed = mv.querySelector(`.cm-editor.cm-merge-${side}`)!;
          const r = mv.getBoundingClientRect();
          const s = ed.querySelector(".cm-scroller")!.getBoundingClientRect();
          const y = Math.max(r.top, s.top);
          return [...ed.querySelectorAll(".cm-content > .cm-line")].find((l) => l.getBoundingClientRect().top >= y)
            ?.textContent;
        };
        return [top("a"), top("b")];
      });
  }

  for (const [mode, opts] of modes) {
    test(`scattered edits, inserts and deletes (${mode})`, async ({ workbench: page }) => {
      const path = "big/scattered.ts";
      const ms = await openCase(page, path, opts);
      test.info().annotations.push({ type: "open", description: `${ms} ms` });
      expect(ms, "time to open").toBeLessThan(8_000);
      await expectCount(page, path, 42);
      // The first change is a single edited identifier.
      await page.locator(".cm-editor.cm-merge-b .cm-content").first().click();
      await page.keyboard.press("Meta+ArrowUp");
      await page.keyboard.press("F7");
      await expect(counter(page)).toHaveText("1 of 42 differences");
      const first = await rendered(page);
      if (opts.mode !== "unified") {
        expect(first.a.words).toContainEqual(["compute", "modified"]);
        expect(first.b.words).toContainEqual(["computeFast", "modified"]);
      }
      // The last difference is reachable and still highlighted.
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.press("Shift+F7");
      await expect(counter(page)).toHaveText("42 of 42 differences");
      const last = await rendered(page);
      if (opts.mode === "unified") expect(last.b.lines).toContain("inserted");
      else expect(last.b.words).toContainEqual(["computeFast", "modified"]);
      await scrollToEnd(page);
      if (opts.mode !== "unified") {
        const [a, b] = await topLines(page);
        expect(a, "panes line up at the end").toBe(b);
        // Collapsed, the unchanged tail folds away.
        if (!opts.collapse) expect(b).toMatch(/value99\d\d/);
      }
      await shot(page, `scattered-${mode.replace(" ", "-")}`);
    });
  }

  test("every tenth line edited: 1,000 differences", async ({ workbench: page }) => {
    const path = "big/every-tenth.ts";
    const ms = await openCase(page, path, { alignChanges: false });
    test.info().annotations.push({ type: "open", description: `${ms} ms` });
    expect(ms, "time to open").toBeLessThan(8_000);
    await expectCount(page, path, 1_000);
    await scrollToEnd(page);
    const { a, b } = await rendered(page);
    expect(b.words.length).toBeGreaterThan(0);
    expect(b.words.every(([t, k]) => t === "entry" && k === "modified")).toBe(true);
    expect(a.words.every(([t, k]) => t === "item" && k === "modified")).toBe(true);
    await shot(page, "every-tenth");
  });

  for (const [mode, opts] of modes.slice(0, 3))
    test(`every line edited: one 10,000-line block (${mode})`, async ({ workbench: page }) => {
      const path = "big/rewrite.ts";
      const ms = await openCase(page, path, opts);
      test.info().annotations.push({ type: "open", description: `${ms} ms` });
      expect(ms, "time to open").toBeLessThan(8_000);
      await expectCount(page, path, 1);
      await scrollToEnd(page);
      const { b } = await rendered(page);
      if (opts.mode === "unified") expect(b.lines.every((k) => k === "inserted")).toBe(true);
      else {
        expect(b.lines.length).toBeGreaterThan(10);
        expect(b.lines.every((k) => k === "modified")).toBe(true);
        expect(b.words).toContainEqual(["let", "modified"]);
      }
      await shot(page, `rewrite-${mode.replace(" ", "-")}`);
    });
});
