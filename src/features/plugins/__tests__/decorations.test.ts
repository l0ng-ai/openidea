import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { loadMarkdown, renderMarkup } from "@/editor/lsp/markdown";
import { getFileDecoration } from "@/workbench/contributions";
import { decorationExtension, setPluginDecorations } from "../decorations";
import { capabilityDescription } from "../consent";
import { handleRuntimeEvent } from "../runtimeUi";

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
