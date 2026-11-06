import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Markdown } from "./Markdown";

const { openFile, openExternalUrl } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));
const readImage = vi.fn<(path: string) => Promise<string>>();
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ openFile }) }));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));
const { renderMermaidIn } = vi.hoisted(() => ({
  renderMermaidIn: vi.fn(() => ({ async: false, done: Promise.resolve(), cancel: () => {} })),
}));
vi.mock("@/features/viewers/markdown/mermaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/viewers/markdown/mermaid")>()),
  renderMermaidIn,
}));

beforeEach(() => {
  vi.clearAllMocks();
  readImage.mockReset().mockResolvedValue(PIXEL);
  mockIPC((cmd, args) => (cmd === "fs_read_image" ? readImage((args as { path: string }).path) : null));
});
afterEach(clearMocks);

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

it("hands mermaid fences to the diagram renderer instead of highlighting them", () => {
  const { container } = render(<Markdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} cwd="/repo" />);
  const block = container.querySelector("[data-mermaid]")!;
  expect(block.querySelector("code")!.textContent!.trimEnd()).toBe("flowchart LR\n  A --> B");
  expect(block.querySelector("pre button[data-copy]")).toBeNull();
  expect(block.querySelector<HTMLElement>(":scope > button[data-copy]")!.dataset.copy).toBe("flowchart LR\n  A --> B");
  expect(renderMermaidIn).toHaveBeenCalledWith(container.firstElementChild, expect.any(Array));
});

it("draws diagrams again in the new theme after a theme switch", async () => {
  document.documentElement.dataset.theme = "dark";
  render(<Markdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} cwd="/repo" />);
  expect(renderMermaidIn).toHaveBeenCalledTimes(1);
  await act(async () => {
    document.documentElement.dataset.theme = "light";
  });
  expect(renderMermaidIn).toHaveBeenCalledTimes(2);
});

it("keeps other fences as highlighted code with a copy button", () => {
  const { container } = render(<Markdown text={"```ts\nconst a = 1;\n```"} cwd="/repo" />);
  expect(container.querySelector("[data-mermaid]")).toBeNull();
  expect(container.querySelector("pre button[data-copy]")).not.toBeNull();
  expect(renderMermaidIn).not.toHaveBeenCalled();
});

it("does not treat a mermaid placeholder written in the reply as a diagram", () => {
  const { container } = render(
    <Markdown text={'<div data-mermaid=""><pre><code>flowchart LR</code></pre></div>'} cwd="/repo" />,
  );
  expect(container.querySelector("[data-mermaid]")).toBeNull();
  expect(renderMermaidIn).not.toHaveBeenCalled();
});
