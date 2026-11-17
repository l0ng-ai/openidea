// @vitest-environment jsdom
import { Terminal, type IDecoration, type IDecorationOptions } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findTerminalLinks } from "./links";
import { installLinkHighlights, xtermLink } from "./linkHighlights";
import { buildLinkColor } from "./theme";

const mock = vi.hoisted(() => ({ highlightHyperlinks: true }));
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ terminal: { highlightHyperlinks: mock.highlightHyperlinks } }),
}));

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe("terminal link highlights", () => {
  const terms: Terminal[] = [];
  const created: Array<{ options: IDecorationOptions; decoration: IDecoration }> = [];

  const createTerm = (cols = 60, rows = 5) => {
    window.matchMedia ??= (() =>
      ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 500 });
    term.open(host);
    const register = term.registerDecoration.bind(term);
    term.registerDecoration = (options) => {
      const decoration = register(options);
      if (decoration) created.push({ options, decoration });
      return decoration;
    };
    terms.push(term);
    return term;
  };

  /** `{ line, x, width }` of every live link decoration, top to bottom. */
  const live = () =>
    created
      .filter((d) => !d.decoration.isDisposed)
      .map(({ options: o }) => ({ line: o.marker.line, x: o.x, width: o.width, fg: o.foregroundColor }))
      .sort((a, b) => a.line - b.line || (a.x ?? 0) - (b.x ?? 0));

  beforeEach(() => {
    mock.highlightHyperlinks = true;
    created.length = 0;
  });
  afterEach(() => {
    while (terms.length) terms.pop()!.dispose();
    document.body.replaceChildren();
  });

  it("colours every visible URL without hovering, in cell columns", async () => {
    const term = createTerm();
    const links = installLinkHighlights(term, () => "#112233");
    // The reporter's case: a dev server banner, plus a CJK prefix (two cells per glyph) and two URLs on one row.
    await write(
      term,
      "  ➜  Local:   http://localhost:5173/\r\n访问 https://a.dev 或 https://b.dev/x.\r\nno links here",
    );
    links.update();
    expect(live()).toEqual([
      { line: 0, x: 14, width: 22, fg: "#112233" },
      { line: 1, x: 5, width: 13, fg: "#112233" },
      { line: 1, x: 22, width: 15, fg: "#112233" },
    ]);
    links.dispose();
    expect(live()).toEqual([]);
  });

  it("does nothing while Highlight hyperlinks is off, and follows the toggle on refresh", async () => {
    mock.highlightHyperlinks = false;
    const term = createTerm();
    const links = installLinkHighlights(term, () => "#112233");
    await write(term, "https://example.com");
    links.update();
    expect(live()).toEqual([]);
    mock.highlightHyperlinks = true;
    links.refresh();
    links.update();
    expect(live()).toHaveLength(1);
    mock.highlightHyperlinks = false;
    links.update();
    expect(live()).toEqual([]);
  });

  it("only decorates rows near the viewport as output scrolls", async () => {
    const term = createTerm(60, 5);
    const links = installLinkHighlights(term, () => "#112233");
    for (let i = 0; i < 100; i++) {
      await write(term, `row ${i} https://example.com/${i}\r\n`);
      links.update();
    }
    const top = term.buffer.active.viewportY;
    expect(live().every((d) => d.line >= top - term.rows && d.line < top + 2 * term.rows)).toBe(true);
    expect(live().length).toBeLessThanOrEqual(3 * term.rows);
    // Every visible URL row is still highlighted.
    for (let y = top; y < top + term.rows; y++) {
      if (term.buffer.active.getLine(y)!.translateToString(true).includes("https://"))
        expect(live().some((d) => d.line === y)).toBe(true);
    }
  });

  it("drops a highlight when its line is overwritten", async () => {
    const term = createTerm();
    const links = installLinkHighlights(term, () => "#112233");
    await write(term, "https://example.com");
    links.update();
    expect(live()).toHaveLength(1);
    await write(term, "\r\x1b[2Kdone");
    links.update();
    expect(live()).toEqual([]);
  });

  it("clears in the alternate buffer and comes back after it", async () => {
    const term = createTerm();
    const links = installLinkHighlights(term, () => "#112233");
    await write(term, "https://example.com\r\n");
    links.update();
    expect(live()).toHaveLength(1);
    await write(term, "\x1b[?1049hhttps://inside.vim");
    links.update();
    expect(live()).toEqual([]);
    await write(term, "\x1b[?1049l");
    links.update();
    expect(live()).toHaveLength(1);
  });

  it("redraws with the new colour after a theme change", async () => {
    const term = createTerm();
    let color = "#112233";
    const links = installLinkHighlights(term, () => color);
    await write(term, "https://example.com");
    links.update();
    color = "#445566";
    links.refresh();
    links.update();
    expect(live().map((d) => d.fg)).toEqual(["#445566"]);
  });

  it("builds click ranges in cells and skips the hover underline on highlighted URLs", async () => {
    const term = createTerm();
    await write(term, "访问 https://a.dev src/main.rs:10");
    const line = term.buffer.active.getLine(0)!;
    const [url, file] = findTerminalLinks(line.translateToString(true)).map((l) =>
      xtermLink(term, line, 1, l, () => {}),
    );
    expect(url!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 18, y: 1 } });
    expect(url!.decorations).toEqual({ underline: false, pointerCursor: true });
    expect(file!.decorations).toEqual({ underline: true, pointerCursor: true });
    mock.highlightHyperlinks = false;
    expect(xtermLink(term, line, 1, findTerminalLinks("https://a.dev")[0]!, () => {}).decorations?.underline).toBe(
      true,
    );
  });

  it("reads the link colour from the theme's --link token, else the accent", () => {
    expect(buildLinkColor((n) => ({ "--link": "#71a1fe", "--accent": "#000000" })[n] ?? "")).toBe("#71a1fe");
    expect(buildLinkColor((n) => (n === "--accent" ? "rgb(1, 2, 3)" : ""))).toBe("#010203");
  });
});
