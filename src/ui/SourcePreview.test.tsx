import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SourcePreview } from "./SourcePreview";

/** A stable loader reference (a new function reloads, like the real module-level ones). */
const loadOf = (content: string) => () => Promise.resolve(content);

const firstTok = (container: HTMLElement) => container.querySelector<HTMLElement>("[class*='tok-']");

describe("SourcePreview", () => {
  it("colours lines with the whole file as context", async () => {
    const { container } = render(
      <SourcePreview path="/p/a.ts" line={1} load={loadOf('const lib = "x";\n/* block\ncomment */')} />,
    );
    await waitFor(() => expect(container.querySelector(".tok-string")).toBeTruthy(), { timeout: 5000 });
    expect(container.querySelector(".tok-string")?.textContent).toBe('"x"');
    // `comment */` only reads as a comment tail when the file was parsed whole.
    expect(container.querySelector('[data-line="2"] .tok-comment')?.textContent).toBe("comment */");
  });

  it("marks ranges inside tokens without losing text", async () => {
    const content = 'const lib = "xyz";';
    const { container } = render(
      <SourcePreview path="/p/a.ts" line={0} load={loadOf(content)} highlights={[{ line: 0, ranges: [[13, 15]] }]} />,
    );
    await waitFor(() => expect(container.querySelector("mark .tok-string")).toBeTruthy(), { timeout: 5000 });
    // `xy` sits inside the string token: marked, while the rest stays coloured.
    expect(container.querySelector("mark")?.textContent).toBe("xy");
    expect(container.querySelector("mark .tok-string")?.textContent).toBe("xy");
    expect(container.textContent).toBe(`1${content}`);
  });

  it("leaves unknown languages plain", async () => {
    const content = 'const lib = "x";';
    const { container } = render(<SourcePreview path="/p/a.unknownext" line={0} load={loadOf(content)} />);
    await screen.findByText(content);
    expect(firstTok(container)).toBeNull();
    expect(container.textContent).toContain(content);
  });

  it("stays plain beyond the parse cap", async () => {
    const filler = "// filler line to pass the parse cap\n".repeat(16000);
    const { container } = render(
      <SourcePreview path="/p/big.ts" line={0} load={loadOf(`${filler}const lib = "x";`)} />,
    );
    await waitFor(() => expect(container.querySelector('[data-line="0"]')?.textContent).toContain("filler"));
    expect(firstTok(container)).toBeNull();
  });

  it("recolours when the file changes", async () => {
    const load = loadOf('const lib = "x";');
    const { container, rerender } = render(<SourcePreview path="/p/a.ts" line={0} load={load} />);
    await waitFor(() => expect(container.querySelector(".tok-string")).toBeTruthy(), { timeout: 5000 });
    rerender(<SourcePreview path="/p/b.unknownext" line={0} load={load} />);
    await screen.findByText('const lib = "x";');
    expect(firstTok(container)).toBeNull();
  });
});
