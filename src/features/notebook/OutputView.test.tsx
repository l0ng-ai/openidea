import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render } from "@testing-library/react";

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}));
const sanitizedSvgUrl = vi.hoisted(() => vi.fn((_source: string) => "data:image/svg+xml,clean"));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));
vi.mock("./security", async (original) => {
  const actual = await original<typeof import("./security")>();
  return {
    ...actual,
    imageMimeUrl: (bundle: Record<string, unknown>) =>
      typeof bundle["image/svg+xml"] === "string" && bundle["image/svg+xml"]
        ? sanitizedSvgUrl(bundle["image/svg+xml"])
        : actual.imageMimeUrl(bundle),
  };
});

const { CellOutputs, MarkdownCell } = await import("./OutputView");
const PNG = "iVBORw0KGgo=";

describe("notebook Markdown preview", () => {
  it("leaves native interactions such as <details> alone and only claims links", () => {
    const { container } = render(
      <MarkdownCell source={"<details><summary>More</summary>body</details>"} attachments={{}} path="/p/a.ipynb" />,
    );
    const summary = container.querySelector("summary")!;
    const click = createEvent.click(summary);
    fireEvent(summary, click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("opens web links with the system handler", () => {
    openExternalUrl.mockClear();
    const { container } = render(
      <MarkdownCell source="[docs](https://example.com/docs)" attachments={{}} path="/p/a.ipynb" />,
    );
    const link = container.querySelector("a[data-notebook-href]")!;
    const click = createEvent.click(link);
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps the rendered preview across snapshots with equal attachments", () => {
    const attachments = { "a.png": { "image/png": PNG } };
    const source = "text ![a](attachment:a.png)";
    const { container, rerender } = render(
      <MarkdownCell source={source} attachments={attachments} path="/p/a.ipynb" />,
    );
    const paragraph = container.querySelector("p")!;
    rerender(<MarkdownCell source={source} attachments={structuredClone(attachments)} path="/p/a.ipynb" />);
    expect(container.querySelector("p")).toBe(paragraph);
    rerender(<MarkdownCell source={source} attachments={{ "a.png": { "image/png": "AAAA" } }} path="/p/a.ipynb" />);
    expect(container.querySelector("p")).not.toBe(paragraph);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it.each([
    ["Markdown destination", "![a](attachment&#58;a.png)"],
    ["reference definition", "![a][r]\n\n[r]: attachment&#58;a.png"],
    ["raw HTML", '<img src="attachment&#x3A;a.png" alt="a">'],
  ])("resolves an entity-encoded attachment in a %s", (_kind, source) => {
    const { container } = render(
      <MarkdownCell source={source} attachments={{ "a.png": { "image/png": PNG } }} path="/p/a.ipynb" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
  });

  it.each(["__proto__", "constructor"])("resolves an attachment named %s from parsed notebook JSON", (name) => {
    const attachments = JSON.parse(`{${JSON.stringify(name)}:{"image/png":"${PNG}"}}`);
    const { container } = render(
      <MarkdownCell source={`![a](attachment:${name})`} attachments={attachments} path="/p/a.ipynb" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
  });

  it("does not resolve inherited members as attachments", () => {
    const { container } = render(
      <MarkdownCell source="![a](attachment:constructor)" attachments={{}} path="/p/a.ipynb" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("a");
  });

  it("does not rebuild when only an unreferenced attachment changes", () => {
    const source = "![a](attachment:a.png)";
    const { container, rerender } = render(
      <MarkdownCell source={source} attachments={{ "a.png": { "image/png": PNG } }} path="/p/a.ipynb" />,
    );
    const image = container.querySelector("img")!;
    rerender(
      <MarkdownCell
        source={source}
        attachments={{ "a.png": { "image/png": PNG }, "b.png": { "image/png": "AAAA" } }}
        path="/p/a.ipynb"
      />,
    );
    expect(container.querySelector("img")).toBe(image);
  });

  it("ignores attachment identity when the source references none", () => {
    const { container, rerender } = render(<MarkdownCell source="plain" attachments={{}} path="/p/a.ipynb" />);
    const paragraph = container.querySelector("p")!;
    rerender(<MarkdownCell source="plain" attachments={{}} path="/p/a.ipynb" />);
    expect(container.querySelector("p")).toBe(paragraph);
  });
});

describe("notebook image outputs", () => {
  it("does not re-sanitize an unchanged SVG when a fresh snapshot arrives", () => {
    sanitizedSvgUrl.mockClear();
    const output = () => [{ output_type: "display_data", data: { "image/svg+xml": "<svg></svg>" }, metadata: {} }];
    const { rerender } = render(<CellOutputs outputs={output()} />);
    rerender(<CellOutputs outputs={output()} />);
    expect(sanitizedSvgUrl).toHaveBeenCalledTimes(1);
    rerender(<CellOutputs outputs={[{ output_type: "display_data", data: { "image/svg+xml": "<svg><g/></svg>" } }]} />);
    expect(sanitizedSvgUrl).toHaveBeenCalledTimes(2);
  });
});
