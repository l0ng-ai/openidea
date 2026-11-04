import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

const { openFile, openExternalUrl } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ openFile }) }));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));

beforeEach(() => vi.clearAllMocks());

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
