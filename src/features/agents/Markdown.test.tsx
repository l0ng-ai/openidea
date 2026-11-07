import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { resetMermaidForTests } from "../viewers/markdown/mermaid";
import { StrictMode } from "react";
import { Markdown } from "./Markdown";

const { openFile, openExternalUrl } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));
const copyText = vi.hoisted(() => vi.fn());
const readImage = vi.fn<(path: string) => Promise<string>>();
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ openFile }) }));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));
vi.mock("@/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/ui")>()), copyText }));

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: mermaid.initialize, render: mermaid.render } }));

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
        `<svg id="${id}"><defs><marker id="${id}-arrow" orient="auto"><path d="M0,0L8,4"/></marker></defs>` +
        `<path d="M0,4" marker-end="url(#${id}-arrow)"/><text>${text.split("\n")[0]}</text></svg>`,
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

it.each(["#section", "//example.com/image.jpg", "javascript:alert(1)", "/tmp/%ZZ.jpg"])(
  "does not open unsupported links as files: %s",
  (href) => {
    const { container } = render(<Markdown text={`[Link](${href})`} cwd="/repo" />);
    fireEvent.click(container.querySelector("a")!);
    expect(openFile).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  },
);

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

it.each([PIXEL, "https://example.com/code.png", "http://localhost:9000/code.png"])(
  "keeps an inline or web image: %s",
  (src) => {
    render(<Markdown text={`![QR](${src})`} cwd="/repo" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", src);
    expect(screen.getByRole("img")).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(readImage).not.toHaveBeenCalled();
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
  readImage.mockRejectedValueOnce({ kind: "io", message: "missing", data: null });
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
  render(<Markdown text="![QR](https://example.com/gone.png)" cwd="/repo" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByRole("img")).not.toHaveAttribute("src");
  expect(screen.getByRole("img")).toHaveAttribute("alt", "Unable to load image: https://example.com/gone.png");
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
    // Every marker reference resolves inside its own copy.
    for (const root of [one.container, two.container]) {
      const svg = root.querySelector(".mermaid-output svg")!;
      const ref = svg.querySelector("[marker-end]")!.getAttribute("marker-end")!;
      expect(new Set(idsOf(root)).has(/url\(#(.+)\)/.exec(ref)![1]!)).toBe(true);
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
