import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, activateHover, getTooltip, hoverTooltip, showTooltip, tooltips } from "@codemirror/view";
import type { DecorationSet } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { loadMarkdown, renderMarkup } from "@/editor/lsp/markdown";
import { getFileDecoration } from "@/workbench/contributions";
import { decorationExtension, setPluginDecorations } from "../decorations";
import { capabilityDescription } from "../consent";
import { handleRuntimeEvent } from "../runtimeUi";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const ctx: EditorDocContext = {
  doc: 1,
  path: "/p/a.txt",
  language: "text",
  uiMode: null,
  readOnly: false,
};
let editor: TextEditorHandle;
const range = { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } };
const set = (root = "/p"): DecorationSet => ({
  root,
  path: "/p/a.txt",
  setId: "test",
  tree: false,
  items: [
    {
      range,
      style: "highlight",
      hover: "hover",
      after: "<plain>",
      markdownHover: null,
    },
  ],
  file: null,
});
beforeEach(() => {
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  editor = {
    ctx,
    view: new EditorView({
      state: EditorState.create({
        doc: "😀text",
        extensions: [EditorState.allowMultipleSelections.of(true), decorationExtension(ctx)],
      }),
      parent: document.body,
    }),
  };
  _addEditor(editor);
});
afterEach(() => {
  setPluginDecorations("test", []);
  _removeEditor(editor);
  editor.view.destroy();
  useProject.setState({ project: null });
});

it("renders plain annotations, maps them through edits, and withdraws them", () => {
  setPluginDecorations("test", [set()]);
  expect(editor.view.dom.textContent).toContain("<plain>");
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  expect(editor.view.dom.querySelector("plain")).toBeNull();
  editor.view.dispatch({ changes: { from: 0, insert: "x" } });
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  setPluginDecorations("test", []);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
});

it.each(["initial hover", "warm initial hover", "live refresh"])(
  "blocks automatic plugin Markdown resources on %s",
  async (phase) => {
    // jsdom has resource loading disabled; these addresses must never be requested.
    const markdown = [
      "**safe text** [safe link](https://docs.example.invalid/guide)",
      '<a href="https://docs.example.invalid/raw">raw safe link</a>',
      "[source](file:///p/a.txt#L1) [library](jdt://contents/a.class)",
      "`![literal](https://code.example.invalid/inline)`",
      '```text\n<img src="https://code.example.invalid/fenced">\n```',
      "![preview](https://assets.example.invalid/markdown)",
      "![relative](/plugin-resource)",
      '<img src="//assets.example.invalid/raw" srcset="https://assets.example.invalid/2x 2x" onerror="alert(1)">',
      '<picture><source srcset="https://assets.example.invalid/source 1x"><img src="https://assets.example.invalid/fallback"></picture>',
      '<video autoplay src="https://assets.example.invalid/video" poster="https://assets.example.invalid/poster"><source src="https://assets.example.invalid/media"><track src="https://assets.example.invalid/track"></video>',
      '<audio autoplay src="https://assets.example.invalid/audio"></audio>',
      '<input type="image" src="https://assets.example.invalid/input">',
      '<table background="https://assets.example.invalid/background"><tr><td>safe table</td></tr></table>',
      '<svg><image href="https://assets.example.invalid/svg"></image></svg>',
      '<math><mtext><img src="https://assets.example.invalid/math"></mtext></math>',
      '<iframe src="https://assets.example.invalid/frame"></iframe>',
      '<object data="https://assets.example.invalid/object"><embed src="https://assets.example.invalid/embed"></object>',
      '<link rel="stylesheet" href="https://assets.example.invalid/style">',
      '<div style="background:url(https://assets.example.invalid/css)">safe raw text</div>',
    ].join("\n\n");
    const item = (markdownHover: string) => ({
      ...set(),
      items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover }],
    });
    if (phase === "warm initial hover") await loadMarkdown();
    setPluginDecorations("test", [item(phase === "live refresh" ? "loading conversation" : markdown)]);
    vi.useFakeTimers();
    try {
      const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
      label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }
    const card = document.querySelector(".cm-tooltip .cm-lsp-hover")!;
    expect(card).not.toBeNull();
    // The first hover exercises the lazy parser; subsequent cases use the loaded parser.
    await loadMarkdown();
    if (phase === "live refresh") {
      expect(card.textContent).toContain("loading conversation");
      setPluginDecorations("test", [item(markdown)]);
      expect(document.querySelector(".cm-tooltip .cm-lsp-hover")).toBe(card);
    }
    await vi.waitFor(() => expect(card.querySelector("strong")?.textContent).toBe("safe text"));
    expect([...card.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://docs.example.invalid/guide",
      "https://docs.example.invalid/raw",
      "file:///p/a.txt#L1",
      "jdt://contents/a.class",
    ]);
    expect(card.querySelector("pre > code")?.textContent).toBe('<img src="https://code.example.invalid/fenced">');
    expect(card.textContent).toContain("![literal](https://code.example.invalid/inline)");
    expect(card.textContent).toContain("safe raw text");
    expect(card.querySelector("td")?.textContent).toBe("safe table");
    expect([
      ...card.querySelectorAll(
        "img, picture, source, video, audio, track, iframe, object, embed, link, style, svg, math, [src], [srcset], [poster], [background], [srcdoc], [style], [onerror]",
      ),
    ]).toEqual([]);
  },
);

it("reports a failed Markdown load without retrying or inserting plugin resources", async () => {
  await loadMarkdown();
  const failure = new Error("Markdown chunk unavailable");
  const loader = vi.spyOn(await import("@/editor/lsp/markdown"), "loadMarkdown").mockRejectedValueOnce(failure);
  const logger = vi.spyOn(await import("@/platform/errorLog"), "logError").mockImplementation(() => {});
  try {
    setPluginDecorations("test", [
      {
        ...set(),
        items: [
          {
            range,
            style: "highlight",
            hover: null,
            after: " + model",
            markdownHover: "**safe text** ![remote](https://assets.example.invalid/image)",
          },
        ],
      },
    ]);
    vi.useFakeTimers();
    const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(400);
    expect(logger).toHaveBeenCalledExactlyOnceWith("cannot render plugin Markdown", failure);
    expect(loader).toHaveBeenCalledTimes(1);
    const card = document.querySelector(".cm-tooltip .cm-lsp-hover")!;
    expect(card.textContent).toContain("safe text");
    expect(card.querySelector("img, [src], [srcset]")).toBeNull();
  } finally {
    vi.useRealTimers();
    loader.mockRestore();
    logger.mockRestore();
  }
});

it("leaves the shared documentation image policy unchanged", async () => {
  await loadMarkdown();
  const dom = renderMarkup({ kind: "markdown", value: "![docs](https://docs.example.invalid/image)" });
  expect(dom.querySelector("img")?.getAttribute("src")).toBe("https://docs.example.invalid/image");
});

it("renders a Markdown hover card instead of the native tooltip", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [
        {
          range,
          style: "highlight",
          hover: "plain tooltip",
          after: " + model",
          markdownHover: "**model** card",
        },
      ],
    },
  ]);
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  expect(label.getAttribute("title")).toBeNull();
  expect(editor.view.dom.querySelector('[title="plain tooltip"]')).toBeNull();

  vi.useFakeTimers();
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  const card = document.querySelector(".cm-tooltip .cm-lsp-hover");
  expect(card?.textContent).toContain("model");
  vi.useRealTimers();
});

it("keeps the Markdown hover after the caret moves", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover: "**model** card" }],
    },
  ]);
  // A click or arrow key is an ordinary selection transaction.
  editor.view.dispatch({ selection: { anchor: 0 } });

  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector(".cm-tooltip .cm-lsp-hover")?.textContent).toContain("model");
  vi.useRealTimers();
});

it("keeps the Markdown hover after an edit shifts the label", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover: "**model** card" }],
    },
  ]);
  editor.view.dispatch({ changes: { from: 0, insert: "xy" } });

  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector(".cm-tooltip .cm-lsp-hover")?.textContent).toContain("model");
  vi.useRealTimers();
});

it("updates an open hover card when the plugin loads the conversation", async () => {
  const item = (markdownHover: string) => ({
    ...set(),
    items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover }],
  });
  setPluginDecorations("test", [item("**model** is loading…")]);
  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  const card = document.querySelector(".cm-tooltip .cm-lsp-hover")!;
  expect(card.textContent).toContain("loading");

  // Hydration finishes while the card is open; the same card shows it.
  setPluginDecorations("test", [item("the real conversation")]);
  expect(card.textContent).toContain("the real conversation");
  vi.useRealTimers();
});

it("filters project roots and unknown styles and replaces tree badges", () => {
  setPluginDecorations("test", [set("/other")]);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
  const unknown = set();
  unknown.items[0]!.style = "unknown";
  setPluginDecorations("test", [unknown]);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
  const tree = {
    ...set(),
    tree: true,
    items: [],
    file: { style: "modified", badge: "M", tooltip: "changed" },
  };
  setPluginDecorations("test", [tree]);
  expect(getFileDecoration("/p/a.txt")?.badge).toBe("M");
  setPluginDecorations("test", []);
  expect(getFileDecoration("/p/a.txt")?.badge).toBeUndefined();
});

it("selects UTF-16 ranges and reveals without changing text", () => {
  handleRuntimeEvent({
    type: "editorRanges",
    path: ctx.path,
    ranges: [range],
    reveal: false,
  });
  expect(editor.view.state.selection.main.from).toBe(2);
  expect(editor.view.state.selection.main.to).toBe(4);
  handleRuntimeEvent({
    type: "editorRanges",
    path: ctx.path,
    ranges: [range],
    reveal: true,
  });
  expect(editor.view.state.doc.toString()).toBe("😀text");
  handleRuntimeEvent({
    type: "editorRanges",
    path: "/other/a.txt",
    ranges: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 1 } }],
    reveal: false,
  });
  expect(editor.view.state.selection.main.from).toBe(2);
});

it("describes ide.commands explicitly in consent", () => {
  const description = capabilityDescription({
    id: "ide.commands",
    description: "",
    optional: false,
    granted: false,
    risk: "high",
  });
  expect(description).toContain("including running programs, committing and pushing");
});

async function openResizeHover(markdown = "**model** conversation") {
  setPluginDecorations("test", [
    { ...set(), items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover: markdown }] },
  ]);
  vi.useFakeTimers();
  try {
    const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(400);
  } finally {
    vi.useRealTimers();
  }
  const card = document.querySelector<HTMLElement>(".cm-tooltip .cm-lsp-hover")!;
  expect(card).not.toBeNull();
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 240));
  vi.spyOn(card.closest(".cm-tooltip")!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 240));
  return card;
}

function resizePointer(target: EventTarget, type: string, x: number, y: number, buttons = 1) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

it.each([
  ["n", 0, -60, 400, 300],
  ["e", 80, 0, 480, 240],
  ["s", 0, 60, 400, 300],
  ["w", -80, 0, 480, 240],
  ["se", 80, 60, 480, 300],
] as const)("resizes the model hover by its %s edge", async (edge, dx, dy, width, height) => {
  const card = await openResizeHover();
  const handle = card.querySelector<HTMLButtonElement>(`button[data-edge="${edge}"]`);
  expect(handle).not.toBeNull();
  expect(handle!.getAttribute("aria-label")).toBeTruthy();
  resizePointer(handle!, "pointerdown", 300, 220);
  resizePointer(window, "pointermove", 300 + dx, 220 + dy);
  expect(card.style.width).toBe(`${width}px`);
  expect(card.style.height).toBe(`${height}px`);
  resizePointer(window, "pointerup", 300 + dx, 220 + dy, 0);
  expect(document.documentElement.hasAttribute("data-drag-cursor")).toBe(false);
});

it("anchors a long-line conversation to its model label and follows its rendered position", async () => {
  const code = "x".repeat(1000);
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: code } });
  const longRange = { start: { line: 0, col: 0 }, end: { line: 0, col: code.length } };
  setPluginDecorations("test", [
    {
      ...set(),
      items: [{ range: longRange, style: "highlight", hover: null, after: " + model", markdownHover: "conversation" }],
    },
  ]);
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  const labelRect = vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(800, 300, 150, 20));
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue(new DOMRect(20, 300, 1, 20));
  vi.useFakeTimers();
  try {
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 850, clientY: 310 }));
    await vi.advanceTimersByTimeAsync(400);
    const tooltip = editor.view.state.facet(showTooltip)[0]!;
    const rendered = getTooltip(editor.view, tooltip)!;
    expect(rendered.getCoords!(tooltip.pos).left).toBe(800);
    expect(rendered.getCoords!(tooltip.pos).top).toBe(300);
    labelRect.mockReturnValue(new DOMRect(500, 340, 150, 20));
    expect(rendered.getCoords!(tooltip.pos).left).toBe(500);
    expect(rendered.getCoords!(tooltip.pos).top).toBe(340);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a body-hosted conversation open while crossing from its label, then dismisses outside", async () => {
  editor.view.dispatch({ effects: StateEffect.appendConfig.of(tooltips({ parent: document.body })) });
  const card = await openResizeHover("conversation message\n\n".repeat(40));
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 380, 100, 20));
  expect(editor.view.dom.contains(card)).toBe(false);
  editor.view.dom.dispatchEvent(
    new MouseEvent("mouseleave", { relatedTarget: document.body, clientX: 450, clientY: 370 }),
  );
  expect(card.isConnected).toBe(true);
  document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450, clientY: 355 }));
  expect(card.isConnected).toBe(true);
  card.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450, clientY: 320 }));
  const handle = card.querySelector<HTMLButtonElement>('button[data-edge="se"]')!;
  resizePointer(handle, "pointerdown", 490, 330);
  resizePointer(window, "pointermove", 570, 390);
  resizePointer(window, "pointerup", 570, 390, 0);
  expect(card.isConnected).toBe(true);
  expect(card.style.width).toBe("480px");
  expect(card.style.height).toBe("300px");
  expect(card.textContent).toContain("conversation message");
  document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
  expect(card.isConnected).toBe(false);
});

it("keeps a hydrated conversation anchored to the replacement model label", async () => {
  const card = await openResizeHover("loading conversation");
  const handle = card.querySelector<HTMLButtonElement>('button[data-edge="e"]')!;
  resizePointer(handle, "pointerdown", 490, 220);
  resizePointer(window, "pointermove", 570, 220);
  resizePointer(window, "pointerup", 570, 220, 0);
  setPluginDecorations("test", [
    {
      ...set(),
      items: [
        { range, style: "highlight", hover: null, after: " + model", markdownHover: "the hydrated conversation" },
      ],
    },
  ]);
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(620, 380, 100, 20));
  const tooltip = editor.view.state.facet(showTooltip)[0]!;
  expect(getTooltip(editor.view, tooltip)!.getCoords!(tooltip.pos).left).toBe(620);
  expect(document.querySelector(".cm-tooltip .cm-lsp-hover")).toBe(card);
  expect(card.textContent).toContain("the hydrated conversation");
  expect(card.style.width).toBe("480px");
});

it.each(["Escape", "outside pointer", "window blur", "window leave", "editor destruction"])(
  "cleans up an interactive conversation on %s",
  async (action) => {
    const card = await openResizeHover();
    const handle = card.querySelector<HTMLButtonElement>('button[data-edge="e"]')!;
    resizePointer(handle, "pointerdown", 490, 220);
    resizePointer(window, "pointermove", 570, 220);
    expect(document.documentElement.hasAttribute("data-drag-cursor")).toBe(true);
    if (action === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (action === "outside pointer") resizePointer(document.body, "pointerdown", 10, 10);
    else if (action === "window blur") window.dispatchEvent(new Event("blur"));
    else if (action === "window leave")
      document.documentElement.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: null }));
    else editor.view.destroy();
    expect(card.isConnected).toBe(false);
    expect(document.documentElement.hasAttribute("data-drag-cursor")).toBe(false);
    resizePointer(window, "pointermove", 800, 220);
    expect(card.style.width).toBe("480px");
  },
);

it("dismisses only the plugin conversation, not another provider's hover", async () => {
  const other = hoverTooltip(() => ({
    pos: 0,
    create: () => {
      const dom = document.createElement("div");
      dom.textContent = "other provider";
      return { dom };
    },
  }));
  editor.view.dispatch({ effects: StateEffect.appendConfig.of(other) });
  const card = await openResizeHover();
  activateHover(editor.view, 0, 1, { tooltip: other });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(card.isConnected).toBe(false);
  expect(document.body.textContent).toContain("other provider");
  expect(editor.view.state.field(other.active)).toHaveLength(1);
});

it("opens the configured commit detail URL when the conversation SHA is clicked", async () => {
  const sha = "2b03ef6774cfb016dcf8c48f849c0684d8908c6a";
  const url = `https://tenant.example.invalid/gitai/admin/repos/commit?repo=https%3A%2F%2Fgithub.com%2Fl0ng-ai%2Fopenidea&sha=${sha}`;
  await loadMarkdown();
  const card = await openResizeHover(`[${sha.slice(0, 8)}](${url})`);
  const link = card.querySelector("a")!;
  expect(link.getAttribute("href")).toBe(url);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  try {
    link.click();
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(url));
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([null, " + model"])(
  "keeps a text-origin conversation open throughout its annotated range (%s)",
  async (after) => {
    const code = "x".repeat(1000);
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: code } });
    const longRange = { start: { line: 0, col: 0 }, end: { line: 0, col: code.length } };
    setPluginDecorations("test", [
      {
        ...set(),
        items: [{ range: longRange, style: "highlight", hover: null, after, markdownHover: "text conversation" }],
      },
    ]);
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((pos) => new DOMRect(pos, 10, 1, 10));
    vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ x }) => Math.round(x));
    vi.spyOn(editor.view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 600));
    const line = editor.view.contentDOM.querySelector(".cm-line")!;
    vi.useFakeTimers();
    try {
      line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 15 }));
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }
    const card = document.querySelector<HTMLElement>(".cm-tooltip .cm-lsp-hover")!;
    expect(card).not.toBeNull();
    vi.spyOn(card.closest(".cm-tooltip")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 30, 400, 100));
    line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 510, clientY: 15 }));
    expect(card.isConnected).toBe(true);
    line.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1300, clientY: 15 }));
    expect(card.isConnected).toBe(false);
  },
);

it("does not strand a naturally opened second hover after crossing the popup gap", async () => {
  const other = hoverTooltip(() => ({
    pos: 0,
    end: 6,
    create: () => {
      const dom = document.createElement("div");
      dom.textContent = "natural provider";
      return { dom };
    },
  }));
  editor.view.dispatch({ effects: StateEffect.appendConfig.of([other, tooltips({ parent: document.body })]) });
  const card = await openResizeHover();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 380, 100, 20));
  expect(editor.view.state.field(other.active)).toHaveLength(1);
  editor.view.dom.dispatchEvent(
    new MouseEvent("mouseleave", { relatedTarget: document.body, clientX: 450, clientY: 370 }),
  );
  expect(card.isConnected).toBe(true);
  card.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450, clientY: 320 }));
  card
    .closest(".cm-tooltip")!
    .dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body, clientX: 10, clientY: 10 }));
  document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
  expect(card.isConnected).toBe(false);
  expect(editor.view.state.field(other.active)).toHaveLength(0);
});

it("uses the rich model label rather than a plain annotation at the same offset", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [
        { range, style: "highlight", hover: null, after: "plain note", markdownHover: null },
        { range, style: "highlight", hover: null, after: " + model", markdownHover: "conversation" },
      ],
    },
  ]);
  const spans = [...editor.view.dom.querySelectorAll("span")];
  const plain = spans.find((span) => span.textContent === "plain note")!;
  const label = spans.find((span) => span.textContent === " + model")!;
  vi.spyOn(plain, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 300, 100, 20));
  vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(800, 300, 100, 20));
  vi.useFakeTimers();
  try {
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 850, clientY: 310 }));
    await vi.advanceTimersByTimeAsync(400);
    const tooltip = editor.view.state.facet(showTooltip)[0]!;
    expect(getTooltip(editor.view, tooltip)!.getCoords!(tooltip.pos).left).toBe(800);
  } finally {
    vi.useRealTimers();
  }
});

it("does not select a conversation when identical model labels make the anchor ambiguous", async () => {
  const item = { range, style: "highlight", hover: null, after: " + model", markdownHover: "first conversation" };
  setPluginDecorations("test", [{ ...set(), items: [item] }]);
  setPluginDecorations("second", [{ ...set(), items: [{ ...item, markdownHover: "second conversation" }] }]);
  vi.useFakeTimers();
  try {
    const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector(".cm-tooltip .cm-lsp-hover")).toBeNull();
  } finally {
    vi.useRealTimers();
    setPluginDecorations("second", []);
  }
});

it("withdraws a removed conversation without hiding another provider", async () => {
  const other = hoverTooltip(() => ({
    pos: 0,
    end: 6,
    create: () => {
      const dom = document.createElement("div");
      dom.textContent = "remaining provider";
      return { dom };
    },
  }));
  editor.view.dispatch({ effects: StateEffect.appendConfig.of(other) });
  const card = await openResizeHover();
  expect(editor.view.state.field(other.active)).toHaveLength(1);
  setPluginDecorations("test", []);
  expect(card.isConnected).toBe(false);
  expect(editor.view.state.field(other.active)).toHaveLength(1);
  expect(document.body.textContent).toContain("remaining provider");
});
