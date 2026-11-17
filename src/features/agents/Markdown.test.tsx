import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { resetMermaidForTests } from "../viewers/markdown/mermaid";
import { StrictMode } from "react";
import { useProject } from "@/platform/project";
import type { SymbolMatch } from "@/platform/ipc";
import { Markdown, markdownBlocks, markdownHtml } from "./Markdown";

const { openFile, chooseDeclaration, openExternalUrl } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  chooseDeclaration: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));
const copyText = vi.hoisted(() => vi.fn());
const readImage = vi.fn<(path: string) => Promise<string>>();
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
vi.mock("@/workbench/contributions", () => ({
  editorService: () => ({ openFile, chooseDeclaration }),
}));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));
vi.mock("@/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui")>()),
  copyText,
}));

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({
  default: { initialize: mermaid.initialize, render: mermaid.render },
}));

const DIAGRAM = "flowchart TD\n    A-->B";
const FENCE = `\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n`;

beforeEach(() => {
  vi.clearAllMocks();
  readImage.mockReset().mockResolvedValue(PIXEL);
  resetMermaidForTests();
  mermaid.render.mockReset().mockImplementation(async (id: string, text: string) => {
    // Like mermaid: a measuring node under <body> while rendering.
    const tmp = document.createElement("div");
    tmp.id = `d${id}`;
    document.body.append(tmp);
    return {
      svg:
        `<svg id="${id}"><style>#${id} .flowchart-link{fill:none;}#${id} [id$="-arrow"] path{fill:#9fa2a8;}</style>` +
        `<defs><marker id="${id}-arrow" orient="auto"><path d="M0,0L8,4"/></marker></defs>` +
        `<path class="flowchart-link" d="M0,4" marker-end="url(#${id}-arrow)"/><text>${text.split("\n")[0]}</text></svg>`,
    };
  });
  mockIPC((cmd, args) => (cmd === "fs_read_image" ? readImage((args as { path: string }).path) : null));
});
afterEach(clearMocks);

it("keeps one copy control outside each code block when effects restart", () => {
  const { container } = render(
    <StrictMode>
      <Markdown
        text={"Before\n\n```text\nrust/\n└── src/main.rs\n```\n\n```ts\nconst a = 1;\n```\n\nAfter"}
        cwd="/repo"
      />
    </StrictMode>,
  );
  expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(2);
  const blocks = [...container.querySelectorAll("pre")];
  expect(blocks.map((pre) => pre.textContent)).toEqual(["rust/\n└── src/main.rs", "const a = 1;"]);
  for (const pre of blocks) {
    expect(pre.querySelector("button")).toBeNull();
    expect(pre.parentElement!.querySelectorAll(":scope > button[data-copy]")).toHaveLength(1);
  }
});

it.each([
  "<style>body{outline:7px solid red}</style>",
  '<form action="https://example.com/x"><button>go</button></form>',
  '<div style="position:fixed">x</div>',
  '<link rel="stylesheet" href="https://example.com/x.css">',
  '<meta http-equiv="refresh" content="0;url=https://example.com">',
  '<base href="https://example.com/">',
  '<iframe src="https://example.com"></iframe>',
  '<button formaction="https://example.com/x">go</button>',
])("keeps raw markup from reaching the page: %s", (raw) => {
  const { container } = render(<Markdown text={`text\n\n${raw}`} cwd="/repo" />);
  expect(container.querySelector("style, form, link, meta, base, iframe, [style], [formaction]")).toBeNull();
  expect(container.textContent).not.toContain("outline");
});

it("ignores data attributes written in a reply, keeping its own", () => {
  const { container } = render(
    <Markdown
      text={'<button data-copy="evil">x</button>\n\n<code data-path="/etc/passwd">y</code>\n\n```ts\nconst a = 1;\n```'}
      cwd="/repo"
    />,
  );
  expect(container.querySelector("code[data-path]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "x" }));
  fireEvent.click(container.querySelector("code")!);
  expect(openFile).not.toHaveBeenCalled();
  expect(
    [...container.querySelectorAll<HTMLElement>("button[data-copy]")].map((button) => button.dataset.copy),
  ).toEqual(["const a = 1;"]);
});

it.each([
  ["/Users/thomas/vmos-shots/tiktok-home.jpg", "/Users/thomas/vmos-shots/tiktok-home.jpg", undefined],
  ["images/home.jpg", "/repo/images/home.jpg", undefined],
  ["/tmp/截图%20one.jpg", "/tmp/截图 one.jpg", undefined],
  ["/repo/main.rs:12:5", "/repo/main.rs", { line: 11, col: 4 }],
  ["/repo/main.rs#L7", "/repo/main.rs", { line: 6, col: 0 }],
  ["E:/work/notes.md:773", "E:/work/notes.md", { line: 772, col: 0 }],
  ["E:/work/my%20notes.md#L7", "E:/work/my notes.md", { line: 6, col: 0 }],
  ["E:%5Cwork%5Cnotes.md:3:5", "E:/work/notes.md", { line: 2, col: 4 }],
  ["E%3A%2Fwork%2Fnotes.md", "E:/work/notes.md", undefined],
  ["E:/工作/笔记%20清单.md:3", "E:/工作/笔记 清单.md", { line: 2, col: 0 }],
  ["/E:/work/spec.md", "E:/work/spec.md", undefined],
  ["/E:/work/my%20notes.md#L7", "E:/work/my notes.md", { line: 6, col: 0 }],
  ["%2FE:%5Cwork%5Cnotes.md:3:5", "E:/work/notes.md", { line: 2, col: 4 }],
])("opens a Markdown file link: %s", (href, path, selection) => {
  render(<Markdown text={`[查看文件](${href})`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "查看文件" }));
  expect(openFile).toHaveBeenCalledWith(path, { focus: true, selection });
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it("keeps web links external", () => {
  render(<Markdown text="[Website](https://example.com/image.jpg)" cwd="/repo" />);
  fireEvent.click(screen.getByRole("link"));
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/image.jpg");
  expect(openFile).not.toHaveBeenCalled();
});

it.each([
  ["/E:/work/my%20notes.md#L7", "E:/work/my notes.md:7"],
  ["/E:/work/spec.md:3:5", "E:/work/spec.md:3:5"],
  ["docs/spec.md", "C:/repo/docs/spec.md"],
  ["https://example.com/docs?q=1#section", "https://example.com/docs?q=1#section"],
])("shows the full link target on hover: %s", (href, target) => {
  render(<Markdown text={`[Details](${href})`} cwd="C:/repo" />);
  expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute("title", target);
});

it("keeps an explicit Markdown link title beside its target", () => {
  render(<Markdown text={'[Details](docs/spec.md "Specification")'} cwd="C:/repo" />);
  expect(screen.getByRole("link")).toHaveAttribute("title", "Specification\nC:/repo/docs/spec.md");
});

it.each([
  "#section",
  "//example.com/image.jpg",
  "javascript:alert(1)",
  "/tmp/%ZZ.jpg",
  "E:relative.md",
  "file:///E:/work/notes.md",
  "%5C%5Cevil%5Cshare%5Cx.md",
])("does not open unsupported links as files: %s", (href) => {
  const { container } = render(<Markdown text={`[Link](${href})`} cwd="/repo" />);
  fireEvent.click(container.querySelector("a")!);
  expect(openFile).not.toHaveBeenCalled();
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it("does not preserve drive-letter URLs on elements other than file links", () => {
  const { container } = render(
    <Markdown
      text={'<video src="E:/work/movie.mp4"></video><a href="javascript:alert(1)">Bad link</a>'}
      cwd="C:/repo"
    />,
  );
  expect(container.querySelector("video")).not.toHaveAttribute("src");
  expect(container.querySelector("a")).not.toHaveAttribute("href");
});

it.each([
  ["/Users/thomas/vmos-shots/tiktok-home.jpg", "/repo", "/Users/thomas/vmos-shots/tiktok-home.jpg"],
  ["images/home.jpg", "/repo", "/repo/images/home.jpg"],
  ["/tmp/截图%20one.jpg", "/repo", "/tmp/截图 one.jpg"],
  ["file:///tmp/auth%20code.png", "/repo", "/tmp/auth code.png"],
  ["C:/shots/code.png", "C:/repo", "C:/shots/code.png"],
  ["file:///C:/shots/code.png", "C:/repo", "C:/shots/code.png"],
])("loads a reply image from the project host: %s", async (src, cwd, path) => {
  render(<Markdown text={`![QR code](${src})`} cwd={cwd} />);
  await waitFor(() => expect(readImage).toHaveBeenCalledWith(path));
  await waitFor(() => expect(screen.getByRole("img", { name: "QR code" })).toHaveAttribute("src", PIXEL));
});

it("loads raw HTML images without allowing alternate sources or forged paths", async () => {
  const { container } = render(
    <Markdown
      text={
        '<picture><source srcset="/wrong.png"><img alt="QR" src="/tmp/code.png" srcset="/wrong.png 2x" data-image-src="/forged.png" onerror="alert(1)"></picture>'
      }
      cwd="/repo"
    />,
  );
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", PIXEL));
  expect(readImage).toHaveBeenCalledExactlyOnceWith("/tmp/code.png");
  expect(container.querySelector("source, [srcset], [onerror]")).toBeNull();
});

it("keeps an inline image: a data URL loads without a request", () => {
  render(<Markdown text={`![QR](${PIXEL})`} cwd="/repo" />);
  expect(screen.getByRole("img")).toHaveAttribute("src", PIXEL);
  expect(screen.getByRole("img")).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(readImage).not.toHaveBeenCalled();
});

it.each(["https://example.com/code.png", "http://localhost:9000/code.png"])(
  "loads a web image in a reply only on a click: %s",
  (src) => {
    const { container } = render(<Markdown text={`![QR](${src})`} cwd="/repo" />);
    const img = container.querySelector("img")!;
    // Not fetched on render: a button stands in, the image is hidden with no src.
    expect(img).not.toHaveAttribute("src");
    expect(readImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Load image from ${new URL(src).host}` }));
    expect(img).toHaveAttribute("src", src);
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  },
);

it("reuses image reads while a reply streams, but reads again for another message", async () => {
  const { rerender, unmount } = render(<Markdown text="![QR](/tmp/stream.png)" cwd="/repo" />);
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", PIXEL));
  rerender(<Markdown text="![QR](/tmp/stream.png)\n\nScan to authorize." cwd="/repo" />);
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", PIXEL));
  expect(readImage).toHaveBeenCalledTimes(1);
  unmount();
  render(<Markdown text="![QR](/tmp/stream.png)" cwd="/repo" />);
  await waitFor(() => expect(readImage).toHaveBeenCalledTimes(2));
});

it("reports read failure and retries on the next render", async () => {
  readImage.mockRejectedValueOnce({
    kind: "io",
    message: "missing",
    data: null,
  });
  const { rerender } = render(<Markdown text="![QR](/tmp/missing.png)" cwd="/repo" />);
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("alt", "Unable to load image: /tmp/missing.png"));
  expect(screen.getByRole("img")).not.toHaveAttribute("src");
  rerender(<Markdown text="![QR](/tmp/missing.png)\n\nNow saved." cwd="/repo" />);
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", PIXEL));
});

it("does not update detached images after a streamed reply replaces them", async () => {
  let resolve!: (data: string) => void;
  readImage.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { rerender } = render(<Markdown text="![QR](/tmp/pending.png)" cwd="/repo" />);
  const oldImage = screen.getByRole("img");
  rerender(<Markdown text="Image removed." cwd="/repo" />);
  await act(async () => resolve(PIXEL));
  expect(oldImage).not.toHaveAttribute("src");
});

it.each(["javascript:alert(1)", "data:text/html,test", "/tmp/%ZZ.png", "/tmp/code%00.png"])(
  "does not load unsafe or malformed image sources: %s",
  (src) => {
    render(<Markdown text={`<img alt="QR" src="${src}">`} cwd="/repo" />);
    expect(screen.getByRole("img")).not.toHaveAttribute("src");
    expect(readImage).not.toHaveBeenCalled();
  },
);

it("reports network or decode failures without leaving a broken source", () => {
  const { container } = render(<Markdown text="![QR](https://example.com/gone.png)" cwd="/repo" />);
  fireEvent.click(screen.getByRole("button", { name: "Load image from example.com" }));
  const img = container.querySelector("img")!;
  fireEvent.error(img);
  expect(img).not.toHaveAttribute("src");
  expect(img).toHaveAttribute("alt", "Unable to load image: https://example.com/gone.png");
});

it("drops a reply attribute that names another host, so nothing fetches on render", () => {
  const { container } = render(
    <Markdown
      text={'<video poster="https://example.com/p.jpg"></video><p background="//evil.test/x">x</p>'}
      cwd="/repo"
    />,
  );
  expect(container.querySelector("[poster]")).toBeNull();
  expect(container.querySelector("[background]")).toBeNull();
});

describe("mermaid diagrams in a reply", () => {
  it("renders the fence as a placeholder holding the source, then draws the diagram", async () => {
    const { container } = render(
      <Markdown text={`Before\n\n${FENCE}\n\n\`\`\`ts\nconst a = 1;\n\`\`\``} cwd="/repo" />,
    );
    const block = container.querySelector<HTMLElement>("[data-mermaid]")!;
    expect(block.querySelector("code.language-mermaid")!.textContent).toBe(DIAGRAM);
    expect(container.querySelector("code.language-ts")).not.toBeNull();
    await waitFor(() => expect(block).toHaveAttribute("data-mermaid-state", "ok"));
    expect(block.querySelector(".mermaid-output svg")).not.toBeNull();
    // Temporary nodes mermaid leaves under <body> are removed.
    expect(document.body.querySelector(":scope > [id^='d']")).toBeNull();
  });

  it("draws two equal diagrams with unique SVG ids, so markers of a hidden copy stay live", async () => {
    const one = render(<Markdown text={FENCE} cwd="/repo" />);
    await waitFor(() => expect(one.container.querySelector("[data-mermaid-state='ok']")).not.toBeNull());
    // The second copy (the first now hidden, like a collapsed subagent reply) comes
    // from the cache — and still gets ids of its own.
    const two = render(<Markdown text={FENCE} cwd="/repo" />);
    await waitFor(() => expect(two.container.querySelector("[data-mermaid-state='ok']")).not.toBeNull());
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    const idsOf = (root: HTMLElement) =>
      [...root.querySelectorAll("svg[id], svg [id]")].map((el) => el.getAttribute("id"));
    const idsOne = idsOf(one.container);
    const idsTwo = idsOf(two.container);
    expect(idsOne).toHaveLength(2);
    expect(idsTwo).toHaveLength(2);
    expect(idsOne.filter((id) => idsTwo.includes(id))).toEqual([]);
    // Every marker reference and scoped `<style>` selector resolves inside its own copy.
    for (const root of [one.container, two.container]) {
      const svg = root.querySelector(".mermaid-output svg")!;
      const ref = svg.querySelector("[marker-end]")!.getAttribute("marker-end")!;
      expect(new Set(idsOf(root)).has(/url\(#(.+)\)/.exec(ref)![1]!)).toBe(true);
      expect(svg.querySelector("style")!.textContent).toContain(
        `#${svg.getAttribute("id")} .flowchart-link{fill:none;}`,
      );
      expect(svg.querySelector("defs [id$='-arrow'] path")).not.toBeNull();
    }
  });

  it("keeps the source copyable on the block once the diagram is drawn", async () => {
    const { container } = render(<Markdown text={FENCE} cwd="/repo" />);
    const block = container.querySelector<HTMLElement>("[data-mermaid]")!;
    await waitFor(() => expect(block).toHaveAttribute("data-mermaid-state", "ok"));
    // The drawn diagram hides the code block (and with it the usual per-pre Copy button):
    // the block keeps its own, outside what gets hidden.
    const copy = block.querySelector<HTMLElement>(":scope > button[data-copy]")!;
    expect(copy.dataset.copy).toBe(DIAGRAM);
    expect(block.querySelector("pre button[data-copy]")).toBeNull();
    fireEvent.click(copy);
    expect(copyText).toHaveBeenCalledWith(DIAGRAM);
  });

  it("tells the conversation to follow when a diagram draws after the message rendered", async () => {
    const onDiagramDrawn = vi.fn();
    const { rerender } = render(<Markdown text={FENCE} cwd="/repo" onDiagramDrawn={onDiagramDrawn} />);
    expect(onDiagramDrawn).not.toHaveBeenCalled(); // the draw hasn't finished yet
    await waitFor(() => expect(onDiagramDrawn).toHaveBeenCalledTimes(1));
    // The next streamed chunk hits the cache: drawn in place before paint, so the
    // conversation follows it on its own render pass without another callback.
    rerender(<Markdown text={`${FENCE}\n\nDone.`} cwd="/repo" onDiagramDrawn={onDiagramDrawn} />);
    await act(async () => {});
    expect(onDiagramDrawn).toHaveBeenCalledTimes(1);
  });
});

describe("streamed replies", () => {
  it("cuts a reply into blocks that join back into it", () => {
    const text = "# Plan\n\nFirst *one*.\n\n- a\n- b\n\n```ts\nconst a = 1;\n```\n\nTail";
    const blocks = markdownBlocks(text);
    expect(blocks.join("")).toBe(text);
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => markdownHtml(b)).join("")).toBe(markdownHtml(text));
    expect(markdownBlocks("See [docs][d].\n\n[d]: https://example.com")).toHaveLength(1);
  });

  it("renders an HTML block that wraps Markdown whole", () => {
    const text = "<details>\n<summary>Log</summary>\n\ntext\n\n</details>";
    expect(markdownBlocks(text)).toEqual([text]);
    const { container } = render(<Markdown text={text} cwd="/repo" />);
    expect(container.querySelector("details p")?.textContent).toBe("text");
  });

  it("cuts only what streamed on after the blocks that ended", () => {
    const before = markdownBlocks("One.\n\nTwo.\n\nThr");
    const after = markdownBlocks("One.\n\nTwo.\n\nThree.\n\n- a", before);
    expect(after).toEqual(["One.\n\n", "Two.\n\n", "Three.\n\n", "- a"]);
    expect(after[0]).toBe(before[0]);
    expect(markdownBlocks("Other.\n\nTwo.\n\nThree.", before)).toEqual(["Other.\n\n", "Two.\n\n", "Three."]);
  });

  it("keeps the blocks a chunk didn't change", () => {
    const head = "Intro paragraph.\n\n```ts\nconst a = 1;\n```\n\n";
    const { container, rerender } = render(<Markdown text={`${head}Half a sen`} cwd="/repo" />);
    const intro = container.querySelector("p")!;
    const code = container.querySelector("pre")!;
    rerender(<Markdown text={`${head}Half a sentence, then more.`} cwd="/repo" />);
    expect(container.querySelector("p")).toBe(intro);
    expect(container.querySelector("pre")).toBe(code);
    expect(container.querySelectorAll("p")[1]!.textContent).toBe("Half a sentence, then more.");
    expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(1);
    rerender(<Markdown text="Something else" cwd="/repo" />);
    expect(container.textContent?.trim()).toBe("Something else");
  });
});

describe("symbol links", () => {
  const symbol = (name: string, path: string, line: number): SymbolMatch => ({
    name,
    kind: "class",
    container: null,
    path,
    relPath: path.slice("/repo/".length),
    range: { start: { line, col: 6 }, end: { line, col: 6 + name.length } },
    score: 0,
    indices: [],
  });
  const index = [
    symbol("FooView", "/repo/src/view.ts", 4),
    symbol("BarView", "/repo/src/bar.ts", 1),
    symbol("BarView", "/repo/web/bar.ts", 9),
    symbol("StreamView", "/repo/src/stream.ts", 2),
    symbol("SinkView", "/repo/src/sink.ts", 1),
    symbol("SinkView", "/repo/web/sink.ts", 7),
  ];
  let lookups: string[][];

  beforeEach(() => {
    lookups = [];
    useProject.setState({ project: { root: "/repo" } as never });
    mockIPC((cmd, args) => {
      if (cmd === "fs_probe") throw new Error("missing");
      if (cmd !== "find_symbols_named") return null;
      const { names } = args as { names: string[] };
      lookups.push(names);
      return index.filter((symbol) => names.includes(symbol.name));
    });
  });
  afterEach(() => useProject.setState({ project: null }));

  const code = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll<HTMLElement>("code")].find((span) => span.textContent === text)!;

  it("opens the one definition a name has, and leaves other code plain", async () => {
    const { container } = render(<Markdown text={"`FooView` runs `cargo test`, see `Missing`."} cwd="/repo/one" />);
    await waitFor(() => expect(code(container, "FooView").dataset.path).toBe("/repo/src/view.ts"));
    expect(code(container, "cargo test").dataset.path).toBeUndefined();
    expect(code(container, "Missing").dataset.path).toBeUndefined();
    expect(lookups).toEqual([["FooView", "Missing"]]);
    fireEvent.click(code(container, "FooView"));
    expect(openFile).toHaveBeenCalledWith("/repo/src/view.ts", { focus: true, selection: { line: 4, col: 6 } });
  });

  it("looks a streamed reply's names up once, after its text settles", async () => {
    const reply = "First `StreamView`.\n\nThen `SinkView` in `web/sink.ts` and `StreamView` again.";
    const { container, rerender } = render(<Markdown text={reply.slice(0, 10)} cwd="/repo/two" />);
    for (let end = 12; end <= reply.length; end += 6) rerender(<Markdown text={reply.slice(0, end)} cwd="/repo/two" />);
    rerender(<Markdown text={reply} cwd="/repo/two" />);
    await waitFor(() => expect(code(container, "SinkView").dataset.path).toBe("/repo/web/sink.ts"));
    expect(lookups).toEqual([["StreamView", "SinkView"]]);
    rerender(<Markdown text={`${reply}\n\nDone with \`StreamView\`.`} cwd="/repo/two" />);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(lookups).toHaveLength(1);
  });

  it("shows Go to Declaration's chooser when several files define the name", async () => {
    const { container } = render(<Markdown text={"Both define `BarView`."} cwd="/repo" />);
    await waitFor(() => expect(code(container, "BarView").className).not.toBe(""));
    expect(code(container, "BarView").dataset.path).toBeUndefined();
    fireEvent.click(code(container, "BarView"));
    expect(openFile).not.toHaveBeenCalled();
    expect(chooseDeclaration).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "/repo/src/bar.ts" }), expect.objectContaining({ path: "/repo/web/bar.ts" })],
      "BarView",
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("keeps a file a span names over a symbol of the same name", async () => {
    mockIPC((cmd, args) => {
      if (cmd === "fs_probe") return null;
      if (cmd === "find_symbols_named") lookups.push((args as { names: string[] }).names);
      return null;
    });
    const { container } = render(<Markdown text={"Open `Config.load`."} cwd="/repo/three" />);
    await waitFor(() => expect(code(container, "Config.load").dataset.path).toBe("/repo/three/Config.load"));
  });
});
